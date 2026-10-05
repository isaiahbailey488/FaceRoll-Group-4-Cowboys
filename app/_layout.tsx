import React, { useEffect, useRef, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { View, ActivityIndicator, AppState, StyleSheet } from 'react-native';
import { getCurrentUser, subscribeToAuthState, validateCurrentSession } from '../services/auth';
import Colors from '../constants/Colors';

export default function RootLayout() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [restoreAuthenticatedSession, setRestoreAuthenticatedSession] = useState(false);
  const receivedInitialAuthState = useRef(false);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    let active = true;
    let validationGeneration = 0;

    const applyAuthState = async (user: ReturnType<typeof getCurrentUser>) => {
      const generation = ++validationGeneration;
      const validatedUser = user ? await validateCurrentSession() : null;
      if (!active || generation !== validationGeneration) return;

      if (!receivedInitialAuthState.current) {
        receivedInitialAuthState.current = true;
        setRestoreAuthenticatedSession(Boolean(validatedUser));
      }
      setIsAuthenticated(Boolean(validatedUser));
    };

    const unsubscribe = subscribeToAuthState((user) => {
      void applyAuthState(user);
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && receivedInitialAuthState.current) {
        void applyAuthState(getCurrentUser());
      }
    });
    const validationTimer = setInterval(() => {
      void applyAuthState(getCurrentUser());
    }, 5 * 60 * 1000);

    return () => {
      active = false;
      validationGeneration += 1;
      clearInterval(validationTimer);
      appStateSubscription.remove();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated === null) return;

    const inAuthGroup = segments[0] === '(auth)';

    // A successful interactive sign-in updates Firebase before the async token
    // validation above finishes. Do not let the previous signed-out state send
    // that new session back to Login while it is being validated.
    if (!isAuthenticated && !inAuthGroup && !getCurrentUser()) {
      router.replace('/(auth)/login');
    } else if (isAuthenticated && inAuthGroup && restoreAuthenticatedSession) {
      setRestoreAuthenticatedSession(false);
      router.replace('/(tabs)/home');
    }
  }, [isAuthenticated, restoreAuthenticatedSession, segments, router]);

  if (isAuthenticated === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={Colors.navy} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="join-course" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <Stack.Screen
        name="face-enrollment"
        options={{
          headerShown: false,
          presentation: 'fullScreenModal',
        }}
      />
      <Stack.Screen
        name="attendance-checkin"
        options={{
          headerShown: false,
          presentation: 'fullScreenModal',
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.white,
  },
});
