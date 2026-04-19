import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HeadToHead, HeadToHeadStatus } from '../models';
import {
  acceptHeadToHead,
  cancelHeadToHead,
  declineHeadToHead,
  getIncomingHeadToHead,
  getOutgoingHeadToHead,
  getUserName,
  proposeHeadToHead,
  type AcceptHeadToHeadResult,
  type DeclineOrCancelResult,
  type ProposeHeadToHeadResult,
} from '../services/dbOps';

/**
 * Manages the current user's Head-to-Head challenges.
 *
 * Buckets the H2Hs into four UI-friendly lists:
 *   - incoming:  someone challenged a pending bet of mine, awaiting my accept
 *   - outgoing:  I challenged someone else's bet, awaiting their accept
 *   - active:    challenge accepted, awaiting underlying event result
 *   - history:   resolved (DECLINED / CANCELLED / WON_BY_* / PUSH)
 *
 * Display names for opponents are looked up via getUserName() and cached so
 * we don't re-fetch on every render.
 *
 * @author Cursor (head-to-head feature)
 */
export type HeadToHeadBucket = 'incoming' | 'outgoing' | 'active' | 'history';

export function useHeadToHeadViewModel(currentUserId: string | null) {
  const [items, setItems] = useState<HeadToHead[]>([]);
  const [nameByUid, setNameByUid] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentUserId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [incoming, outgoing] = await Promise.all([
        getIncomingHeadToHead(currentUserId),
        getOutgoingHeadToHead(currentUserId),
      ]);
      // Merge and dedupe (a user could in theory appear on both sides if the
      // collection ever has weird data — stay defensive).
      const merged = new Map<string, HeadToHead>();
      [...incoming, ...outgoing].forEach((h2h) => merged.set(h2h.id, h2h));
      const all = [...merged.values()].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      setItems(all);

      // Resolve opponent display names. The "opponent" depends on perspective:
      // for incoming, it's the challenger; for outgoing, it's the original.
      const opponentUids = new Set<string>();
      all.forEach((h2h) => {
        if (h2h.challengerUserId !== currentUserId) opponentUids.add(h2h.challengerUserId);
        if (h2h.originalUserId   !== currentUserId) opponentUids.add(h2h.originalUserId);
      });
      const missing = [...opponentUids].filter((uid) => !nameByUid[uid]);
      if (missing.length > 0) {
        const fetched = await Promise.all(
          missing.map(async (uid) => [uid, await getUserName(uid).catch(() => uid)] as const),
        );
        setNameByUid((prev) => {
          const next = { ...prev };
          fetched.forEach(([uid, name]) => { next[uid] = name; });
          return next;
        });
      }
    } catch (e) {
      console.error('Failed to load head-to-head challenges', e);
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [currentUserId, nameByUid]);

  useEffect(() => {
    void refresh();
    // We intentionally only depend on currentUserId — refresh's identity
    // changes when nameByUid mutates, which would cause an infinite loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  // ── Bucketing ──────────────────────────────────────────────────
  const buckets = useMemo(() => {
    const incoming: HeadToHead[] = [];
    const outgoing: HeadToHead[] = [];
    const active:   HeadToHead[] = [];
    const history:  HeadToHead[] = [];
    items.forEach((h2h) => {
      const isOriginal   = h2h.originalUserId   === currentUserId;
      const isChallenger = h2h.challengerUserId === currentUserId;
      const status: HeadToHeadStatus = h2h.status;

      if (status === 'PENDING_ACCEPT') {
        if (isOriginal)   incoming.push(h2h);
        if (isChallenger) outgoing.push(h2h);
      } else if (status === 'ACCEPTED') {
        active.push(h2h);
      } else {
        history.push(h2h);
      }
    });
    return { incoming, outgoing, active, history };
  }, [items, currentUserId]);

  // ── Action wrappers ────────────────────────────────────────────
  const propose = useCallback(
    async (originalBetId: string): Promise<ProposeHeadToHeadResult> => {
      if (!currentUserId) {
        return { success: false, error: 'USER_NOT_FOUND' };
      }
      const result = await proposeHeadToHead(originalBetId, currentUserId);
      if (result.success) await refresh();
      return result;
    },
    [currentUserId, refresh],
  );

  const accept = useCallback(
    async (h2hId: string): Promise<AcceptHeadToHeadResult> => {
      if (!currentUserId) {
        return { success: false, error: 'USER_NOT_FOUND' };
      }
      const result = await acceptHeadToHead(h2hId, currentUserId);
      if (result.success) await refresh();
      return result;
    },
    [currentUserId, refresh],
  );

  const decline = useCallback(
    async (h2hId: string): Promise<DeclineOrCancelResult> => {
      if (!currentUserId) {
        return { success: false, error: 'WRONG_USER' };
      }
      const result = await declineHeadToHead(h2hId, currentUserId);
      if (result.success) await refresh();
      return result;
    },
    [currentUserId, refresh],
  );

  const cancel = useCallback(
    async (h2hId: string): Promise<DeclineOrCancelResult> => {
      if (!currentUserId) {
        return { success: false, error: 'WRONG_USER' };
      }
      const result = await cancelHeadToHead(h2hId, currentUserId);
      if (result.success) await refresh();
      return result;
    },
    [currentUserId, refresh],
  );

  /** "OG" or "ME" depending on which side the current user is on. */
  const opponentNameFor = useCallback(
    (h2h: HeadToHead): string => {
      const opponentUid =
        h2h.challengerUserId === currentUserId ? h2h.originalUserId : h2h.challengerUserId;
      return nameByUid[opponentUid] ?? opponentUid.slice(0, 6);
    },
    [currentUserId, nameByUid],
  );

  return {
    loading,
    error,
    buckets,
    items,
    refresh,
    propose,
    accept,
    decline,
    cancel,
    opponentNameFor,
  };
}
