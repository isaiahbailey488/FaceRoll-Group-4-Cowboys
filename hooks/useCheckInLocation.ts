import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { captureCheckInLocation } from '../services/location';
import type { CheckInLocation } from '../shared/checkin-contract';
import { isSampleFresh, locationFeedback, LocationCaptureError, LocationFeedback,
  LocationRequirement, MAX_SAMPLE_AGE_MS } from '../shared/checkin-location';

type LocationState = 'idle' | 'collecting' | 'ready' | 'expired' | 'error';

/** Keep one sample in a ref for this account/session, never in persisted state. */
export function useCheckInLocation(contextKey: string, requirement: LocationRequirement, enabled: boolean, automatic = false) {
  const [state, setState] = useState<LocationState>('idle');
  const [feedback, setFeedback] = useState<LocationFeedback | null>(null);
  const sample = useRef<CheckInLocation | null>(null);
  const sampleScope = useRef<string | null>(null);
  const job = useRef<AbortController | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stage = useRef<'permission' | 'sampling'>('permission');
  const scopeKey = JSON.stringify([contextKey, requirement.kind, requirement.kind === 'required' ? requirement.radiusMeters : null]);
  const context = useRef({ key: scopeKey, requirement, enabled });
  const focused = useRef(false);
  const [visit, setVisit] = useState(0);
  const visitKey = JSON.stringify([visit, scopeKey]);
  const automaticAttempt = useRef<string | null>(null);
  const [initialCompleted, setInitialCompleted] = useState<string | null>(null);
  const [preparedVisit, setPreparedVisit] = useState<string | null>(null);
  context.current = { key: scopeKey, requirement, enabled };
  const currentVisit = useRef(visitKey);
  currentVisit.current = visitKey;

  const releaseSample = useCallback(() => {
    const previous = job.current;
    job.current = null;
    previous?.abort();
    sample.current = null;
    sampleScope.current = null;
    if (expiry.current) clearTimeout(expiry.current);
    expiry.current = null;
    setState(previous => previous === 'error' || previous === 'expired' ? previous : 'idle');
  }, []);
  const clear = useCallback(() => {
    releaseSample();
    setState('idle'); setFeedback(null);
  }, [releaseSample]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    setVisit(previous => previous + 1);
    return () => { focused.current = false; automaticAttempt.current = null; clear(); };
  }, [clear]));

  useEffect(() => {
    clear();
    return clear;
  }, [scopeKey, enabled, clear]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', next => {
      if (next === 'background' || (next !== 'active' && (stage.current === 'sampling' || sample.current))) clear();
    });
    return () => listener.remove();
  }, [clear]);

  const collect = useCallback(async () => {
    if (job.current || !context.current.enabled || !focused.current || AppState.currentState !== 'active') return null;
    clear();
    const key = context.current.key;
    const collectingVisit = currentVisit.current;
    const controller = new AbortController();
    job.current = controller;
    stage.current = 'permission';
    setState('collecting');
    try {
      const value = await captureCheckInLocation({ requirement: context.current.requirement, signal: controller.signal,
        isActive: () => focused.current && context.current.enabled && context.current.key === key && AppState.currentState === 'active',
        onStage: next => { stage.current = next; },
      });
      if (job.current !== controller || controller.signal.aborted || context.current.key !== key || !context.current.enabled) return null;
      if (value === null) { setState('idle'); return null; }
      sample.current = value;
      sampleScope.current = key;
      setPreparedVisit(collectingVisit);
      setState('ready');
      expiry.current = setTimeout(() => {
        sample.current = null; sampleScope.current = null; expiry.current = null;
        setState('expired');
        setFeedback(locationFeedback(new LocationCaptureError('location_stale')));
      }, Math.max(1, value.capturedAtMs + MAX_SAMPLE_AGE_MS - Date.now() + 1));
      return value;
    } catch (error) {
      if (job.current !== controller || controller.signal.aborted || context.current.key !== key) return null;
      setFeedback(locationFeedback(error));
      setState('error');
      return null;
    } finally {
      if (job.current === controller) job.current = null;
    }
  }, [clear]);

  useEffect(() => {
    // One bounded attempt per screen visit/course/consent context. Expiry,
    // errors and app resume never schedule another acquisition here.
    if (!enabled) { automaticAttempt.current = null; return; }
    if (!automatic || visit === 0 || !focused.current || automaticAttempt.current === visitKey) return;
    automaticAttempt.current = visitKey;
    if (requirement.kind !== 'required') { setInitialCompleted(visitKey); return; }
    let cancelled = false;
    void collect().finally(() => {
      if (!cancelled && focused.current && currentVisit.current === visitKey) setInitialCompleted(visitKey);
    });
    return () => { cancelled = true; };
  }, [automatic, visit, visitKey, enabled, requirement.kind, collect]);

  const getSample = useCallback(() => {
    if (!focused.current || !context.current.enabled || sampleScope.current !== context.current.key ||
        AppState.currentState !== 'active' || !isSampleFresh(sample.current)) {
      clear(); return null;
    }
    return sample.current;
  }, [clear]);

  const reportError = useCallback((code: string) => {
    clear();
    setFeedback(locationFeedback(new LocationCaptureError(code)));
    setState('error');
  }, [clear]);

  return { state, feedback, collect, clear, releaseSample, getSample, reportError,
    initialCollectionComplete: !automatic || initialCompleted === visitKey,
    hasPreparedLocation: preparedVisit === visitKey };
}
