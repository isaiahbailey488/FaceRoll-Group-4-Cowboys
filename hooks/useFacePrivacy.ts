import { useEffect, useState } from 'react';
import { subscribeToAuthState, subscribeToProfile, UserProfile } from '../services/auth';
import { faceAccessState } from '../shared/face-privacy';

export function useFacePrivacy() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    let unsubscribeProfile: (() => void) | undefined;
    const unsubscribeAuth = subscribeToAuthState(user => {
      const current = ++generation;
      unsubscribeProfile?.();
      setProfile(null);
      if (!user) { setUnavailable(true); return; }
      setUnavailable(false);
      unsubscribeProfile = subscribeToProfile(user.uid, value => {
        if (active && generation === current) { setProfile(value); setUnavailable(false); }
      }, () => {
        if (active && generation === current) { setProfile(null); setUnavailable(true); }
      });
    });
    return () => { active = false; unsubscribeAuth(); unsubscribeProfile?.(); };
  }, [attempt]);
  return { profile, state: faceAccessState(profile), unavailable,
    retry: () => { setUnavailable(false); setAttempt(value => value + 1); } };
}
