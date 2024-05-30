import {seconds} from "hurdak"
import {assoc, remove, now, inc} from "@welshman/lib"
import {RELAYS, APP_DATA} from "@welshman/util"
import {appDataKeys, personKinds, userKinds} from "src/util/nostr"
import {getFreshness, setFreshness, withIndexers, load, hints} from "src/engine/state"

const attempts = new Map<string, number>()

const getStalePubkeys = (pubkeys: string[], key: string, delta: number) => {
  const result = new Set<string>()

  for (const pubkey of pubkeys) {
    if (!pubkey?.match(/^[0-f]{64}$/)) {
      continue
    }

    // If we've tried a few times, slow down the duplicate requests
    const thisAttempts = inc(attempts.get(pubkey))
    const thisDelta = delta * thisAttempts

    if (getFreshness(key, pubkey) < now() - thisDelta) {
      attempts.set(pubkey, thisAttempts)
      result.add(pubkey)
    }
  }

  return Array.from(result)
}

type LoadPubkeyOpts = {
  force?: boolean
  relays?: string[]
}

const loadPubkeyData = (
  key: string,
  kinds: number[],
  rawPubkeys: string[],
  {force = false, relays = []}: LoadPubkeyOpts = {},
) => {
  const delta = force ? 5 : seconds(5, "minute")
  const pubkeys = getStalePubkeys(rawPubkeys, key, delta)

  if (pubkeys.length === 0) {
    return Promise.resolve([])
  }

  // Add a separate filters for app data so we're not pulling down other people's stuff,
  // or obsolete events of our own.
  const filters = kinds.includes(APP_DATA)
    ? [{kinds: [APP_DATA], "#d": Object.values(appDataKeys)}, {kinds: remove(APP_DATA, kinds)}]
    : [{kinds}]

  return Promise.all(
    hints
      .FromPubkeys(pubkeys)
      .getSelections()
      .map(({relay, values}) =>
        load({
          skipCache: true,
          relays: withIndexers([relay]),
          filters: filters.map(assoc("authors", values)),
          onEvent: e => setFreshness(key, e.pubkey, now()),
        }),
      ),
  )
}

export const loadPubkeyRelays = (pubkeys: string[], opts: LoadPubkeyOpts = {}) =>
  loadPubkeyData("pubkey/relay", [RELAYS], pubkeys, opts)

export const loadPubkeyProfiles = (pubkeys: string[], opts: LoadPubkeyOpts = {}) =>
  loadPubkeyData("pubkey/profile", remove(RELAYS, personKinds), pubkeys, opts)

export const loadPubkeys = async (pubkeys: string[], opts: LoadPubkeyOpts = {}) =>
  // Load relays, then load profiles so we have a better chance of finding them. But also
  // load profiles concurrently so that if we do find them it takes as little time as possible.
  // Requests will be deduplicated by tracking freshness and within welshman
  Promise.all([
    loadPubkeyRelays(pubkeys, opts).then(() => loadPubkeyProfiles(pubkeys, opts)),
    loadPubkeyProfiles(pubkeys, opts),
  ])

export const loadPubkeyUserData = (pubkeys: string[], opts: LoadPubkeyOpts = {}) =>
  loadPubkeyData("pubkey/user", userKinds, pubkeys, {force: true, ...opts})
