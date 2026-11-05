import React from 'react';
import { ActivityIndicator, SafeAreaView, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import Colors from '../constants/Colors';
import { LOCATION_CHECK_IN_PENDING } from '../shared/face-privacy';

export default function FacePrivacyGate({ state, unavailable, retry }: {
  state: 'loading' | 'opted_out' | 'deletion_pending' | 'ready'; unavailable: boolean; retry: () => void;
}) {
  const router = useRouter();
  const loading = state === 'loading' && !unavailable;
  return <SafeAreaView style={styles.container}>
    {loading && <ActivityIndicator size="large" color={Colors.navy} />}
    <Text style={styles.title}>{loading ? 'Checking your preference…' : unavailable ? 'Unable to verify your preference' : 'Facial recognition is off'}</Text>
    <Text style={styles.body}>{unavailable ? 'Check your connection before using the camera.' : state === 'deletion_pending'
      ? 'Your saved facial data is still being deleted. Facial recognition remains disabled.'
      : state === 'opted_out' ? LOCATION_CHECK_IN_PENDING : 'The camera will open only after your preference is verified.'}</Text>
    {unavailable && <TouchableOpacity style={styles.button} onPress={retry}><Text style={styles.label}>Try Again</Text></TouchableOpacity>}
    <TouchableOpacity style={styles.button} onPress={() => router.replace('/(tabs)/home')}><Text style={styles.label}>Back to Home</Text></TouchableOpacity>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.offWhite, padding: 28, gap: 18 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center', color: Colors.navy },
  body: { fontSize: 16, textAlign: 'center', color: Colors.textSecondary },
  button: { backgroundColor: Colors.navy, padding: 14, borderRadius: 10 },
  label: { color: Colors.white, fontWeight: '600' },
});
