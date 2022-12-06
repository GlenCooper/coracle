import {when, assoc, prop, identity, whereEq, reverse, uniq, sortBy, uniqBy, find, last, pluck, groupBy} from 'ramda'
import {debounce} from 'throttle-debounce'
import {writable, get} from 'svelte/store'
import {navigate} from "svelte-routing"
import {switcherFn, ensurePlural} from 'hurdak/lib/hurdak'
import {getLocalJson, setLocalJson, now, timedelta, sleep} from "src/util/misc"
import {user} from 'src/state/user'
import {epoch, filterMatches, Listener, channels, relays, findReplyTo} from 'src/state/nostr'

export const modal = writable(null)

export const settings = writable({
  showLinkPreviews: true,
  dufflepudUrl: import.meta.env.VITE_DUFFLEPUD_URL,
  ...getLocalJson("coracle/settings"),
})

settings.subscribe($settings => {
  setLocalJson("coracle/settings", $settings)
})

export const logout = () => {
  // Give any animations a moment to finish
  setTimeout(() => {
    user.set(null)
    relays.set([])
    navigate("/login")
  }, 200)
}

// Accounts

export const accounts = writable(getLocalJson("coracle/accounts") || {})

accounts.subscribe($accounts => {
  setLocalJson("coracle/accounts", $accounts)
})

user.subscribe($user => {
  if ($user) {
    accounts.update($accounts => ({...$accounts, [$user.pubkey]: $user}))
  }
})

export const ensureAccounts = async (pubkeys, {force = false} = {}) => {
  const $accounts = get(accounts)

  // Don't request accounts we recently updated
  pubkeys = pubkeys.filter(
    k => force || !$accounts[k] || $accounts[k].refreshed < now() - timedelta(10, 'minutes')
  )

  if (pubkeys.length) {
    const events = await channels.getter.all({kinds: [0, 3, 12165], authors: uniq(pubkeys)})

    await accounts.update($accounts => {
      events.forEach(e => {
        const values = {
          muffle: [],
          petnames: [],
          ...$accounts[e.pubkey],
          pubkey: e.pubkey,
          refreshed: now(),
          isUser: true,
        }

        switcherFn(e.kind, {
          0: () => {
            $accounts[e.pubkey] = {...values, ...JSON.parse(e.content)}
          },
          3: () => {
            $accounts[e.pubkey] = {...values, petnames: e.tags}
          },
          12165: () => {
            $accounts[e.pubkey] = {...values, muffle: e.tags}
          },
        })
      })

      return $accounts
    })
  }

  // Keep our user in sync
  user.update($user => $user ? {...$user, ...get(accounts)[$user.pubkey]} : null)
}

export const getFollow = pubkey => {
  const $user = get(user)

  return $user && find(t => t[1] === pubkey, $user.petnames)
}

export const getMuffleValue = pubkey => {
  const $user = get(user)

  if (!$user) {
    return 1
  }

  const tag = find(t => t[1] === pubkey, $user.muffle)

  if (!tag) {
    return 1
  }

  return parseFloat(last(tag))
}

// Notes

export const annotateNotes = async (chunk, {showParents = false} = {}) => {
  const parentIds = chunk.map(findReplyTo).filter(identity)

  if (showParents && parentIds.length) {
    // Find parents of replies to provide context
    const parents = await channels.getter.all({
      kinds: [1],
      ids: parentIds,
    })

    // Remove replies, show parents instead
    chunk = parents
      .concat(chunk.filter(e => !find(whereEq({id: findReplyTo(e)}), parents)))
  }

  chunk = uniqBy(prop('id'), chunk)

  if (chunk.length === 0) {
    return chunk
  }

  const replies = await channels.getter.all({
    kinds: [1],
    '#e': pluck('id', chunk),
  })

  const reactions = await channels.getter.all({
    kinds: [7],
    '#e': pluck('id', chunk.concat(replies)),
  })

  const repliesById = groupBy(
    n => find(t => last(t) === 'reply', n.tags)[1],
    replies.filter(n => n.tags.map(last).includes('reply'))
  )

  const reactionsById = groupBy(
    n => find(t => last(t) === 'reply', n.tags)[1],
    reactions.filter(n => n.tags.map(last).includes('reply'))
  )

  await ensureAccounts(uniq(pluck('pubkey', chunk.concat(replies).concat(reactions))))

  const $accounts = get(accounts)

  const annotate = e => ({
    ...e,
    user: $accounts[e.pubkey],
    replies: uniqBy(prop('id'), (repliesById[e.id] || []).map(reply => annotate(reply))),
    reactions: uniqBy(prop('id'), (reactionsById[e.id] || []).map(reaction => annotate(reaction))),
  })

  return reverse(sortBy(prop('created'), chunk.map(annotate)))
}

export const notesListener = (notes, filter) => {
  const updateNote = (id, f) =>
    notes.update($notes =>
      $notes
        .map(n => {
          if (n.id === id) {
            return f(n)
          }

          return {...n, replies: n.replies.map(when(whereEq({id}), f))}
        })
    )

  const deleteNotes = ($notes, ids) =>
    $notes
      .filter(e => !ids.includes(e.id))
      .map(n => ({
        ...n,
        replies: deleteNotes(n.replies, ids),
        reactions: n.reactions.filter(e => !ids.includes(e.id)),
      }))

  return new Listener(
    ensurePlural(filter).map(assoc('since', now())),
    e => switcherFn(e.kind, {
      1: async () => {
        const id = findReplyTo(e)

        if (id) {
          const [reply] = await annotateNotes([e])

          updateNote(id, n => ({...n, replies: n.replies.concat(reply)}))
        } else if (filterMatches(filter, e)) {
          const [note] = await annotateNotes([e])

          notes.update($notes => uniqBy(prop('id'), [note].concat($notes)))
        }
      },
      5: () => {
        const ids = e.tags.map(t => t[1])

        notes.update($notes => deleteNotes($notes, ids))
      },
      7: () => {
        const id = findReplyTo(e)

        updateNote(id, n => ({...n, reactions: n.reactions.concat(e)}))
      }
    })
  )
}

// UI

export const createScroller = (
  cursor,
  onChunk,
  {since = epoch, reverse = false} = {}
) => {
  const startingDelta = cursor.delta

  let active = false

  const start = debounce(1000, async () => {
    if (active) {
      return
    }

    active = true

    /* eslint no-constant-condition: 0 */
    while (true) {
      // While we have empty space, fill it
      const {scrollY, innerHeight} = window
      const {scrollHeight} = document.body

      if (
        (reverse && scrollY > innerHeight * 3)
        || (!reverse && scrollY + innerHeight * 3 < scrollHeight)
      ) {
        break
      }

      // Stop if we've gone back far enough
      if (cursor.since <= since) {
        break
      }

      // Get our chunk
      const chunk = await cursor.chunk()

      // Notify the caller
      if (chunk.length > 0) {
        await onChunk(chunk)
      }

      // If we have an empty chunk, increase our step size so we can get back to where
      // we might have old events. Once we get a chunk, knock it down to the default again
      if (chunk.length === 0) {
        cursor.delta = Math.min(timedelta(30, 'days'), cursor.delta * 2)
      } else {
        cursor.delta = startingDelta
      }

      if (!active) {
        break
      }

      // Wait a moment before proceeding to the next chunk for the caller
      // to load results into the dom
      await sleep(300)
    }

    active = false
  })

  return {
    start,
    stop: () => { active = false },
    isActive: () => Boolean(cursor.sub),
  }
}
