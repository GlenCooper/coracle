import crypto from "crypto"
import {get} from "svelte/store"
import {cached, nth, groupBy, now} from "@welshman/lib"
import type {TrustedEvent} from "@welshman/util"
import {
  Tag,
  Tags,
  createEvent,
  getLnUrl,
  Address,
  getIdAndAddress,
  isShareableRelayUrl,
  isSignedEvent,
  normalizeRelayUrl,
  FOLLOWS,
  RELAYS,
  PROFILE,
} from "@welshman/util"
import {Fetch, chunk, createMapOf, randomId, seconds, sleep, tryFunc} from "hurdak"
import {
  assoc,
  flatten,
  identity,
  inc,
  map,
  omit,
  partition,
  pluck,
  prop,
  reject,
  uniq,
  uniqBy,
  whereEq,
  without,
} from "ramda"
import {stripExifData, blobToFile} from "src/util/html"
import {joinPath} from "src/util/misc"
import {appDataKeys, generatePrivateKey, getPublicKey} from "src/util/nostr"
import {
  asDecryptedEvent,
  makeSingleton,
  editSingleton,
  createSingleton,
  readSingleton,
} from "src/domain"
import type {RelayPolicy, Session, NostrConnectHandler} from "src/engine/model"
import {GroupAccess} from "src/engine/model"
import {NostrConnectBroker} from "src/engine/utils"
import {repository} from "src/engine/repository"
import {
  canSign,
  channels,
  loadOne,
  tagsFromContent,
  createAndPublish,
  deriveAdminKeyForGroup,
  deriveGroup,
  deriveIsGroupMember,
  deriveSharedKeyForGroup,
  displayProfileByPubkey,
  env,
  forcePlatformRelays,
  getClientTags,
  groupAdminKeys,
  groupSharedKeys,
  groups,
  hints,
  mention,
  nip04,
  nip44,
  nip59,
  people,
  pubkey,
  publish,
  relayPolicies,
  relays,
  session,
  sessions,
  sign,
  signer,
  stateKey,
  topics,
  user,
  withIndexers,
  optimisticReadReceipts,
  unpublishedReadReceipts,
  setFreshness,
  getFreshness,
  handles,
  zappers,
  getPlaintext,
} from "src/engine/state"
import {loadHandle, loadZapper} from "src/engine/requests"

// Helpers

export const updateRecord = (record, timestamp, updates) => {
  for (const [field, value] of Object.entries(updates)) {
    const tsField = `${field}_updated_at`
    const lastUpdated = record?.[tsField] || -1

    if (timestamp > lastUpdated) {
      record = {
        ...record,
        [field]: value,
        [tsField]: timestamp,
        updated_at: Math.max(timestamp, record?.updated_at || 0),
      }
    }
  }

  return record
}

export const updateStore = (store, timestamp, updates) =>
  store.set(updateRecord(store.get(), timestamp, updates))

// Files

export const nip98Fetch = async (url, method, body = null) => {
  const tags = [
    ["u", url],
    ["method", method],
  ]

  if (body) {
    tags.push(["payload", crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")])
  }

  const template = createEvent(27235, {tags})
  const $signer = signer.get()

  const event = $signer.isEnabled()
    ? await $signer.signAsUser(template)
    : await $signer.signWithKey(template, generatePrivateKey())

  const auth = btoa(JSON.stringify(event))
  const headers = {Authorization: `Nostr ${auth}`}

  return Fetch.fetchJson(url, {body, method, headers})
}

export const getMediaProviderURL = cached({
  maxSize: 10,
  getKey: ([url]) => url,
  getValue: ([url]) => fetchMediaProviderURL(url),
})

const fetchMediaProviderURL = async host =>
  prop("api_url", await Fetch.fetchJson(joinPath(host, ".well-known/nostr/nip96.json")))

const fileToFormData = file => {
  const formData = new FormData()

  formData.append("file[]", file)

  return formData
}

export const uploadFileToHost = async (url, file) => {
  const startTime = now()
  const apiUrl = await getMediaProviderURL(url)
  const response = await nip98Fetch(apiUrl, "POST", fileToFormData(file))

  // If the media provider uses delayed processing, we need to wait for the processing to be done
  while (response.processing_url) {
    const {status, nip94_event} = await nip98Fetch(response.processing_url, "GET")

    if (status === "success") {
      return nip94_event
    }

    if (now() - startTime > 60) {
      break
    }

    await sleep(3000)
  }

  return response.nip94_event
}

export const uploadFilesToHost = (url, files) =>
  Promise.all(files.map(file => tryFunc(async () => await uploadFileToHost(url, file))))

export const uploadFileToHosts = (urls, file) =>
  Promise.all(urls.map(url => tryFunc(async () => await uploadFileToHost(url, file))))

export const uploadFilesToHosts = async (urls, files) =>
  flatten(await Promise.all(urls.map(url => uploadFilesToHost(url, files)))).filter(identity)

export const compressFiles = (files, opts) =>
  Promise.all(
    files.map(async f => {
      if (f.type.match("image/(webp|gif)")) {
        return f
      }

      return blobToFile(await stripExifData(f, opts))
    }),
  )

export const eventsToMeta = (events: TrustedEvent[]) => {
  const tagsByHash = groupBy((tags: Tags) => tags.get("ox").value(), events.map(Tags.fromEvent))

  // Merge all nip94 tags together so we can supply as much imeta as possible
  return Array.from(tagsByHash.values()).map(groupedTags => {
    return Tags.wrap(groupedTags.flatMap(tags => tags.unwrap())).uniq()
  })
}

export const uploadFiles = async (urls, files, compressorOpts = {}) => {
  const compressedFiles = await compressFiles(files, compressorOpts)
  const nip94Events = await uploadFilesToHosts(urls, compressedFiles)

  return eventsToMeta(nip94Events)
}

// Handles/Zappers

export const updateHandle = async ({pubkey, created_at}, {nip05}) => {
  if (!nip05 || getFreshness("handle", pubkey) >= created_at) {
    return
  }

  setFreshness("handle", pubkey, created_at)

  const handle = await loadHandle(nip05)

  if (handle?.pubkey === pubkey) {
    handles.update(assoc(pubkey, {...handle, nip05}))
  }
}

export const updateZapper = async ({pubkey, created_at}, {lud16, lud06}) => {
  const address = (lud16 || lud06 || "").toLowerCase()

  if (!address) {
    return
  }

  const lnurl = getLnUrl(address)

  if (!lnurl || getFreshness("zapper", pubkey) >= created_at) {
    return
  }

  setFreshness("zapper", pubkey, created_at)

  const zapper = await loadZapper(lnurl)

  if (zapper?.allowsNostr && zapper?.nostrPubkey) {
    zappers.update(assoc(pubkey, {...zapper, pubkey, lnurl}))
  }
}

// Relays

export const saveRelay = (url: string) => {
  url = normalizeRelayUrl(url)

  if (isShareableRelayUrl(url)) {
    const relay = relays.key(url).get()

    relays.key(url).merge({
      count: inc(relay?.count || 0),
      first_seen: relay?.first_seen || now(),
      info: {
        last_checked: 0,
      },
    })
  }
}

export const saveRelayPolicy = (e, relays: RelayPolicy[]) => {
  if (relays?.length > 0) {
    updateStore(people.key(e.pubkey), e.created_at, {
      relays: uniqBy(prop("url"), relays).map((relay: RelayPolicy) => {
        saveRelay(relay.url)

        return {read: true, write: true, ...relay}
      }),
    })
  }
}

export const publishRelays = async ($relays: RelayPolicy[]) => {
  updateStore(people.key(stateKey.get()), now(), {relays: $relays})

  if (canSign.get()) {
    createAndPublish({
      kind: 10002,
      tags: $relays
        .filter(r => isShareableRelayUrl(r.url))
        .flatMap(r => {
          const tag = Tag.from(["r", normalizeRelayUrl(r.url)])

          if (r.read && r.write) return [tag.valueOf()]
          if (r.write) return [tag.append("write").valueOf()]
          if (r.read) return [tag.append("read").valueOf()]

          return []
        })
        .concat(getClientTags()),
      relays: withIndexers(forcePlatformRelays(hints.WriteRelays().getUrls())),
    })
  }
}

export const requestRelayAccess = async (url: string, claim: string, sk?: string) =>
  createAndPublish({
    kind: 28934,
    tags: [["claim", claim]],
    relays: [url],
    sk,
  })

export const joinRelay = async (url: string, claim?: string) => {
  url = normalizeRelayUrl(url)

  if (claim && canSign.get()) {
    await requestRelayAccess(url, claim)
  }

  // Re-publish user meta to the new relay
  broadcastUserData([url])

  return publishRelays([
    ...reject(whereEq({url}), relayPolicies.get()),
    {url, read: true, write: true} as RelayPolicy,
  ])
}

export const leaveRelay = (url: string) =>
  publishRelays(reject(whereEq({url}), relayPolicies.get()))

export const setRelayPolicy = (url: string, policy: Partial<RelayPolicy>) =>
  publishRelays(
    relayPolicies
      .get()
      .filter(p => p.url !== url)
      .concat({url, read: false, write: false, ...policy}),
  )

export const publishReview = (content, tags, relays = null) =>
  createAndPublish({
    kind: 1986,
    tags: [...tags, ...getClientTags(), ...tagsFromContent(content)],
    content,
    relays,
  })

// Groups

// Key state management

export const initSharedKey = address => {
  const privkey = generatePrivateKey()
  const pubkey = getPublicKey(privkey)
  const key = {
    group: address,
    pubkey: pubkey,
    privkey: privkey,
    created_at: now(),
  }

  groupSharedKeys.key(pubkey).set(key)

  return key
}

export const initGroup = (kind, relays) => {
  const id = randomId()
  const privkey = generatePrivateKey()
  const pubkey = getPublicKey(privkey)
  const address = `${kind}:${pubkey}:${id}`
  const sharedKey = kind === 35834 ? initSharedKey(address) : null
  const adminKey = {
    group: address,
    pubkey: pubkey,
    privkey: privkey,
    created_at: now(),
    relays,
  }

  groupAdminKeys.key(pubkey).set(adminKey)

  groups.key(address).set({id, pubkey, address, relays})

  return {id, address, adminKey, sharedKey}
}

// Most people don't have access to nip44 yet, send nip04-encrypted fallbacks for:
// - Access requests
// - Key shares

export const wrapWithFallback = async (template, {author = null, wrap}) => {
  const events = []

  if (nip44.get().isEnabled()) {
    events.push(await nip59.get().wrap(template, {author, wrap}))
  } else {
    events.push(
      await nip59.get().wrap(template, {
        author,
        wrap: {
          ...wrap,
          kind: 1060,
          algo: "nip04",
        },
      }),
    )
  }

  return events
}

const addATags = (template, addresses) => ({
  ...template,
  tags: [...template.tags, ...addresses.map(a => ["a", a])],
})

// Utils for publishing

export const publishToGroupAdmin = async (address, template) => {
  const relays = forcePlatformRelays(hints.WithinContext(address).getUrls())
  const pubkeys = [Address.from(address).pubkey, session.get().pubkey]

  for (const pubkey of pubkeys) {
    const rumors = await wrapWithFallback(template, {
      wrap: {
        tags: [["expiration", String(now() + seconds(30, "day"))]],
        author: generatePrivateKey(),
        recipient: pubkey,
      },
    })

    for (const rumor of rumors) {
      publish({event: rumor.wrap, relays})
    }
  }
}

export const publishAsGroupAdminPublicly = async (address, template) => {
  const relays = forcePlatformRelays(hints.WithinContext(address).getUrls())
  const adminKey = deriveAdminKeyForGroup(address).get()
  const event = await sign(template, {sk: adminKey.privkey})

  return publish({event, relays})
}

export const publishAsGroupAdminPrivately = async (address, template) => {
  const relays = forcePlatformRelays(hints.WithinContext(address).getUrls())
  const adminKey = deriveAdminKeyForGroup(address).get()
  const sharedKey = deriveSharedKeyForGroup(address).get()

  const rumors = await wrapWithFallback(template, {
    author: adminKey.privkey,
    wrap: {
      author: sharedKey.privkey,
      recipient: sharedKey.pubkey,
    },
  })

  const pubs = []

  for (const rumor of rumors) {
    pubs.push(publish({event: rumor.wrap, relays}))
  }

  return pubs
}

export const publishToGroupsPublicly = async (addresses, template, {anonymous = false} = {}) => {
  for (const address of addresses) {
    if (!address.startsWith("34550:")) {
      throw new Error("Attempted to publish publicly to an invalid address", address)
    }
  }

  const event = await sign(addATags(template, addresses), {anonymous})
  const relays = forcePlatformRelays(hints.PublishEvent(event).getUrls())

  return publish({event, relays})
}

export const publishToGroupsPrivately = async (addresses, template, {anonymous = false} = {}) => {
  const events = []
  const pubs = []
  for (const address of addresses) {
    const relays = forcePlatformRelays(hints.WithinContext(address).getUrls())
    const thisTemplate = addATags(template, [address])
    const sharedKey = deriveSharedKeyForGroup(address).get()

    if (!address.startsWith("35834:")) {
      throw new Error("Attempted to publish privately to an invalid address", address)
    }

    if (!deriveIsGroupMember(address).get()) {
      throw new Error("Attempted to publish privately to a group the user is not a member of")
    }

    const rumors = await wrapWithFallback(thisTemplate, {
      author: anonymous ? generatePrivateKey() : null,
      wrap: {
        author: sharedKey.privkey,
        recipient: sharedKey.pubkey,
      },
    })

    for (const rumor of rumors) {
      events.push(rumor)
      pubs.push(publish({event: rumor.wrap, relays}))
    }
  }

  return {events, pubs}
}

export const publishToZeroOrMoreGroups = async (addresses, template, {anonymous = false} = {}) => {
  const pubs = []
  const events = []

  if (addresses.length === 0) {
    const event = await sign(template, {anonymous})
    const relays = forcePlatformRelays(hints.PublishEvent(event).getUrls())

    events.push(event)
    pubs.push(publish({event, relays}))
  } else {
    const [wrap, nowrap] = partition((address: string) => address.startsWith("35834:"), addresses)

    if (wrap.length > 0) {
      const result = await publishToGroupsPrivately(wrap, template, {anonymous})

      for (const event of result.events) {
        events.push(event)
      }

      for (const pub of result.pubs) {
        pubs.push(pub)
      }
    }

    if (nowrap.length > 0) {
      const pub = await publishToGroupsPublicly(nowrap, template, {anonymous})

      events.push(pub.request.event)
      pubs.push(pub)
    }
  }

  return {events, pubs}
}

// Admin functions

export const publishKeyShares = async (address, pubkeys, template) => {
  const adminKey = deriveAdminKeyForGroup(address).get()

  const pubs = []

  for (const pubkey of pubkeys) {
    const relays = hints
      .merge([
        hints.ForPubkeys([pubkey]),
        hints.WithinContext(address),
        hints.fromRelays(env.get().PLATFORM_RELAYS),
      ])
      .policy(hints.addNoFallbacks)
      .getUrls()

    const rumors = await wrapWithFallback(template, {
      author: adminKey.privkey,
      wrap: {
        author: generatePrivateKey(),
        recipient: pubkey,
      },
    })

    for (const rumor of rumors) {
      pubs.push(publish({event: rumor.wrap, relays}))
    }
  }

  return pubs
}

export const publishAdminKeyShares = async (address, pubkeys) => {
  const {relays} = deriveGroup(address).get()
  const {privkey} = deriveAdminKeyForGroup(address).get()
  const template = createEvent(24, {
    tags: [
      ["a", address],
      ["role", "admin"],
      ["privkey", privkey],
      ...getClientTags(),
      ...relays.map(url => ["relay", url]),
    ],
  })

  return publishKeyShares(address, pubkeys, template)
}

export const publishGroupInvites = async (address, pubkeys, gracePeriod = 0) => {
  const {relays} = deriveGroup(address).get()
  const adminKey = deriveAdminKeyForGroup(address).get()
  const {privkey} = deriveSharedKeyForGroup(address).get()
  const template = createEvent(24, {
    tags: [
      ["a", address],
      ["role", "member"],
      ["privkey", privkey],
      ["grace_period", String(gracePeriod)],
      ...getClientTags(),
      ...relays.map(url => ["relay", url]),
    ],
  })

  return publishKeyShares(address, [...pubkeys, adminKey.pubkey], template)
}

export const publishGroupEvictions = async (address, pubkeys) =>
  publishKeyShares(
    address,
    pubkeys,
    createEvent(24, {
      tags: [["a", address], ...getClientTags()],
    }),
  )

export const publishGroupMembers = async (address, op, pubkeys) => {
  const template = createEvent(27, {
    tags: [["op", op], ["a", address], ...getClientTags(), ...pubkeys.map(mention)],
  })

  return publishAsGroupAdminPrivately(address, template)
}

export const publishCommunityMeta = (address, id, feeds, relays, meta) => {
  const template = createEvent(34550, {
    tags: [
      ["d", id],
      ["name", meta.name],
      ["description", meta.about],
      ["banner", meta.banner],
      ["image", meta.picture],
      ...getClientTags(),
      ...(feeds || []),
      ...(relays || []).map(url => ["relay", url]),
    ],
  })

  return publishAsGroupAdminPublicly(address, template)
}

export const publishGroupMeta = (address, id, feeds, relays, meta, listPublicly) => {
  const template = createEvent(35834, {
    tags: [
      ["d", id],
      ["name", meta.name],
      ["about", meta.about],
      ["banner", meta.banner],
      ["picture", meta.picture],
      ...getClientTags(),
      ...(feeds || []),
      ...(relays || []).map(url => ["relay", url]),
    ],
  })

  return listPublicly
    ? publishAsGroupAdminPublicly(address, template)
    : publishAsGroupAdminPrivately(address, template)
}

export const deleteGroupMeta = address =>
  publishAsGroupAdminPublicly(address, createEvent(5, {tags: [["a", address]]}))

// Member functions

export const modifyGroupStatus = (session, address, timestamp, updates) => {
  session.groups = session.groups || {}
  session.groups[address] = updateRecord(session.groups[address], timestamp, updates)

  return session
}

export const setGroupStatus = (pubkey, address, timestamp, updates) =>
  updateSession(pubkey, s => modifyGroupStatus(s, address, timestamp, updates))

export const resetGroupAccess = address =>
  setGroupStatus(pubkey.get(), address, now(), {access: GroupAccess.None})

export const publishGroupEntryRequest = (address, claim = null) => {
  if (deriveAdminKeyForGroup(address).get()) {
    publishGroupInvites(address, [session.get().pubkey])
  } else {
    setGroupStatus(pubkey.get(), address, now(), {access: GroupAccess.Requested})

    const tags = [...getClientTags(), ["a", address]]

    if (claim) {
      tags.push(["claim", claim])
    }

    publishToGroupAdmin(
      address,
      createEvent(25, {
        content: `${displayProfileByPubkey(pubkey.get())} would like to join the group`,
        tags,
      }),
    )
  }
}

export const publishGroupExitRequest = address => {
  setGroupStatus(pubkey.get(), address, now(), {access: GroupAccess.None})

  if (!deriveAdminKeyForGroup(address).get()) {
    publishToGroupAdmin(
      address,
      createEvent(26, {
        content: `${displayProfileByPubkey(pubkey.get())} is leaving the group`,
        tags: [...getClientTags(), ["a", address]],
      }),
    )
  }
}

export const publishCommunitiesList = addresses =>
  createAndPublish({
    kind: 10004,
    tags: [...addresses.map(a => ["a", a]), ...getClientTags()],
    relays: forcePlatformRelays(hints.WriteRelays().getUrls()),
  })

// Miscellaneous commands

export const publishNote = (content, tags = []) =>
  createAndPublish({
    kind: 1,
    content,
    tags,
    relays: forcePlatformRelays(hints.WriteRelays().getUrls()),
  })

export const publishDeletion = ids =>
  createAndPublish({
    kind: 5,
    tags: ids.map(id => [id.includes(":") ? "a" : "e", id]),
    relays: forcePlatformRelays(hints.WriteRelays().getUrls()),
  })

export const publishDeletionForEvent = event => publishDeletion(getIdAndAddress(event))

export const publishProfile = profile =>
  createAndPublish({
    kind: 0,
    tags: getClientTags(),
    content: JSON.stringify(profile),
    relays: forcePlatformRelays(withIndexers(hints.WriteRelays().getUrls())),
  })

export const updateSingleton = async (
  kind,
  {add = [], remove = []}: {add?: string[][]; remove?: string[][]},
) => {
  const updateTags = (tags: string[][]) =>
    uniqBy(nth(1), tags.filter(t => !remove.find(rm => rm[1] === t[1])).concat(add))

  const filters = [{kinds: [kind], authors: [pubkey.get()]}]

  let [event] = repository.query(filters)

  // If we don't have a recent version of the user's petnames loaded, re-fetch to avoid
  // dropping follow updates
  if ((event?.created_at || 0) < now() - seconds(5, "minute")) {
    const loadedEvent = await loadOne({relays: hints.User().getUrls(), filters})

    if ((loadedEvent?.created_at || 0) > (event?.created_at || 0)) {
      event = loadedEvent
    }
  }

  // Preserve content instead of use encrypted tags because kind 3 content is used for
  // relay selections in many places
  const content = event?.content || ""
  const relays = forcePlatformRelays(withIndexers(hints.WriteRelays().getUrls()))
  const encrypt = content => nip44.get().encryptAsUser(content, pubkey.get())

  let encryptable
  if (event) {
    const singleton = readSingleton(asDecryptedEvent(event, {content: getPlaintext(event)}))
    const publicTags = updateTags(singleton.publicTags)

    encryptable = editSingleton({...singleton, publicTags})
  } else {
    const singleton = makeSingleton({kind})
    const publicTags = updateTags(singleton.publicTags)
    encryptable = createSingleton({...singleton, publicTags})
  }

  const template = await encryptable.reconcile(encrypt)

  await createAndPublish({...template, content, relays})
}

export const markAsSeen = async (events: TrustedEvent[]) => {
  if (!signer.get().isEnabled() || events.length === 0) {
    return
  }

  const allIds = [...get(unpublishedReadReceipts), ...pluck("id", events)]

  // If we have fewer than a hefty chunk, optimistically update instead so we're
  // not creating tons of unnecessary events
  if (allIds.length > 100) {
    const expirationTag = ["expiration", String(now() + seconds(90, "day"))]

    if (optimisticReadReceipts.get().length > 0) {
      optimisticReadReceipts.set([])
    }

    for (const ids of chunk(500, allIds)) {
      const template = createEvent(15, {
        tags: [expirationTag, ...ids.map(id => ["e", id])],
      })

      if (nip44.get().isEnabled()) {
        const rumor = await nip59.get().wrap(template, {
          wrap: {
            author: generatePrivateKey(),
            recipient: pubkey.get(),
            tags: [expirationTag],
          },
        })

        publish({
          event: rumor.wrap,
          relays: hints.WriteRelays().getUrls(),
        })
      } else {
        publish({
          event: await signer.get().signAsUser(template),
          relays: hints.WriteRelays().getUrls(),
        })
      }
    }
  } else {
    optimisticReadReceipts.set(allIds)
  }
}

export const addTopic = (e, name) => {
  if (name) {
    const topic = topics.key(name.toLowerCase())

    topic.merge({
      count: inc(topic.get()?.count || 0),
      last_seen: e.created_at,
    })
  }
}

// Messages

export const sendLegacyMessage = async (channelId: string, content: string) => {
  const $pubkey = user.get().pubkey
  const recipients = without([$pubkey], channelId.split(","))

  if (recipients.length > 1) {
    throw new Error("Attempted to send legacy message to more than 1 recipient")
  }

  const pubkey = recipients[0] || $pubkey

  return createAndPublish({
    kind: 4,
    tags: [mention(pubkey), ...getClientTags()],
    content: await nip04.get().encryptAsUser(content, pubkey),
    relays: hints.PublishMessage(pubkey).getUrls(),
  })
}

export const sendMessage = async (channelId: string, content: string) => {
  const recipients = channelId.split(",")
  const template = {
    content,
    kind: 14,
    created_at: now(),
    tags: [...recipients.map(mention), ...getClientTags()],
  }

  for (const pubkey of uniq(recipients.concat(user.get().pubkey))) {
    const rumor = await nip59.get().wrap(template, {
      wrap: {
        author: generatePrivateKey(),
        recipient: pubkey,
      },
    })

    publish({
      event: rumor.wrap,
      relays: hints.merge(recipients.map(hints.PublishMessage)).getUrls(),
    })
  }
}

export const publishChannelsRead = () =>
  setAppData(appDataKeys.NIP24_LAST_CHECKED, createMapOf("id", "last_checked", channels.get()))

export const markAllChannelsRead = () => {
  // @ts-ignore
  channels.update(map(assoc("last_checked", now())))

  publishChannelsRead()
}

export const markChannelRead = (pubkey: string) => {
  channels.key(pubkey).update(assoc("last_checked", now()))

  publishChannelsRead()
}

const addSession = (s: Session) => {
  sessions.update(assoc(s.pubkey, s))
  people.key(s.pubkey).update($p => ({...$p, pubkey: s.pubkey}))
  pubkey.set(s.pubkey)
}

export const loginWithPrivateKey = (privkey, extra = {}) =>
  addSession({method: "privkey", pubkey: getPublicKey(privkey), privkey, ...extra})

export const loginWithPublicKey = pubkey => addSession({method: "pubkey", pubkey})

export const loginWithExtension = pubkey => addSession({method: "extension", pubkey})

export const loginWithNsecBunker = async (pubkey, connectToken, connectRelay) => {
  const connectKey = generatePrivateKey()
  const connectHandler = {relays: [connectRelay]}
  const broker = NostrConnectBroker.get(pubkey, connectKey, connectHandler)
  const result = await broker.connect(connectToken)

  if (result) {
    addSession({
      method: "connect",
      pubkey,
      connectKey,
      connectToken,
      connectHandler,
    })
  }

  return result
}

export const loginWithNostrConnect = async (username, connectHandler: NostrConnectHandler) => {
  const connectKey = generatePrivateKey()
  const {pubkey} = (await loadHandle(`${username}@${connectHandler.domain}`)) || {}

  let broker = NostrConnectBroker.get(pubkey, connectKey, connectHandler)

  if (!pubkey) {
    const pubkey = await broker.createAccount(username)

    if (!pubkey) {
      return null
    }

    broker = NostrConnectBroker.get(pubkey, connectKey, connectHandler)
  }

  const result = await broker.connect()

  if (result) {
    addSession({
      method: "connect",
      pubkey: broker.pubkey,
      connectKey,
      connectHandler,
    })
  }

  return result
}

export const logoutPubkey = pubkey => {
  if (session.get().pubkey === pubkey) {
    throw new Error("Can't destroy the current session, use logout instead")
  }

  sessions.update(omit([pubkey]))
}

export const logout = () => {
  pubkey.set(null)
  sessions.set({})
}

export const setAppData = async (d: string, data: any) => {
  if (canSign.get()) {
    const {pubkey} = session.get()

    return createAndPublish({
      kind: 30078,
      tags: [["d", d]],
      content: await nip04.get().encryptAsUser(JSON.stringify(data), pubkey),
      relays: hints.WriteRelays().getUrls(),
    })
  }
}

export const publishSettings = async (updates: Record<string, any>) => {
  setAppData(appDataKeys.USER_SETTINGS, {
    ...session.get().settings,
    ...updates,
  })
}

export const setSession = (k, data) => sessions.update($s => ($s[k] ? {...$s, [k]: data} : $s))

export const setCurrentSession = data => {
  const $pubkey = pubkey.get()

  if ($pubkey) {
    setSession($pubkey, data)
  }
}

export const updateSession = (k, f) => sessions.update($s => ($s[k] ? {...$s, [k]: f($s[k])} : $s))

export const updateCurrentSession = f => {
  const $pubkey = pubkey.get()

  if ($pubkey) {
    updateSession($pubkey, f)
  }
}

export const broadcastUserData = (relays: string[]) => {
  const authors = [pubkey.get()]
  const kinds = [RELAYS, FOLLOWS, PROFILE]
  const events = repository.query([{kinds, authors}])

  for (const event of events) {
    if (isSignedEvent(event)) {
      publish({event, relays})
    }
  }
}
