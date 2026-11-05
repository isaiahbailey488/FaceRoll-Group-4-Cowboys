import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/** Mount the native camera only for an active capture flow. */
export function useCaptureCamera(enabled: boolean) {
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [requested, setRequested] = useState(true);
  const [ready, setReady] = useState(false);
  const focusedRef = useRef(false);
  const foregroundRef = useRef(AppState.currentState === 'active');
  const enabledRef = useRef(enabled);
  const generation = useRef(0);
  const operation = useRef<symbol | null>(null);
  enabledRef.current = enabled;

  const stop = useCallback(() => {
    setReady(false);
    setRequested(false);
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    operation.current = null;
    stop();
  }, [stop]);

  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    setFocused(true);
    return () => {
      focusedRef.current = false;
      setFocused(false);
      cancel();
    };
  }, [cancel]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      foregroundRef.current = state === 'active';
      setForeground(state === 'active');
      if (state !== 'active') cancel();
    });
    return () => subscription.remove();
  }, [cancel]);

  useEffect(() => {
    if (!enabled) {
      // Invalidate work when permission or facial-recognition consent changes.
      generation.current += 1;
      operation.current = null;
      setReady(false);
    }
  }, [enabled]);

  const start = () => {
    if (!enabledRef.current || !focusedRef.current || !foregroundRef.current) return;
    setReady(false);
    setRequested(true);
  };

  const beginOperation = () => {
    if (operation.current || !enabledRef.current || !focusedRef.current || !foregroundRef.current) return null;
    const token = Symbol('capture');
    const currentGeneration = generation.current;
    operation.current = token;
    return {
      isCurrent: () => generation.current === currentGeneration && enabledRef.current &&
        focusedRef.current && foregroundRef.current,
      finish: () => { if (operation.current === token) operation.current = null; },
    };
  };

  const active = enabled && focused && foreground && requested;
  return {
    active, ready: active && ready, screenActive: focused && foreground,
    start, stop, cancel, beginOperation,
    onReady: () => {
      if (!enabledRef.current || !focusedRef.current || !foregroundRef.current) return;
      setReady(true);
    },
  };
}
