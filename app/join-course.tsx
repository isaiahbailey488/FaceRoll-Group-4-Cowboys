import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import Colors from '../constants/Colors';
import { auth } from '../services/firebase';
import { configuredApiUrl } from '../services/recognition';
import { createJoinFlow, JoinState, requestCourseInvitation } from '../shared/course-join';

export default function JoinCourseScreen() {
  const router = useRouter();
  const [focused, setFocused] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [state, setState] = useState<JoinState>({ stage: 'scanning' });
  const flow = useMemo(() => {
    const owner = auth.currentUser?.uid;
    return createJoinFlow(async (action, token) => {
      const user = auth.currentUser;
      if (!user || user.uid !== owner) throw new Error('Sign in again before joining a course.');
      const result = await requestCourseInvitation(configuredApiUrl(), user, action, token);
      if (auth.currentUser?.uid !== owner) throw new Error('Your account changed. Scan again after signing in.');
      return result;
    }, setState);
  }, []);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    flow.reset();
    return () => { setFocused(false); flow.cancel(); };
  }, [flow]));
  const button = (label: string, action: () => void) => (
    <TouchableOpacity accessibilityRole="button" style={styles.button} onPress={action}>
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Join a course</Text>
        <Text style={styles.subtitle}>Scan the invitation shown by your instructor.</Text>
        {state.stage === 'scanning' && (!permission ? <ActivityIndicator /> : !permission.granted ? (
          <View>
            <Text style={styles.subtitle}>Camera access is needed to scan the course QR code.</Text>
            {button(permission.canAskAgain ? 'Allow camera' : 'Open settings', () => {
              if (permission.canAskAgain) void requestPermission(); else void Linking.openSettings();
            })}
          </View>
        ) : focused ? (
          <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => { void flow.scan(data); }} />
        ) : null)}
        {(state.stage === 'resolving' || state.stage === 'joining') && <View>
          <ActivityIndicator size="large" color={Colors.navy} />
          <Text style={styles.subtitle}>{state.stage === 'joining' ? 'Joining course…' : 'Checking invitation…'}</Text>
        </View>}
        {(state.stage === 'confirm' || state.stage === 'success') && state.course && <View style={styles.card}>
          <Text style={styles.title}>{state.course.courseName}</Text>
          <Text style={styles.subtitle}>{state.course.courseId} · {state.course.instructorName}</Text>
          {state.stage === 'confirm' ? <>
            <Text style={styles.subtitle}>{state.course.alreadyJoined ? 'You already belong to this course.' : 'Confirm to join this course roster.'}</Text>
            {button('Confirm course', () => { void flow.join(); })}
            {button('Scan a different code', flow.reset)}
          </> : <>
            <Text style={styles.subtitle}>{state.course.alreadyJoined ? 'You’re already enrolled.' : 'You joined the course.'}</Text>
            {button('Done', () => router.back())}
          </>}
        </View>}
        {state.stage === 'error' && <View>
          <Text accessibilityRole="alert" style={styles.error}>{state.message || 'Unable to connect. Try again.'}</Text>
          {button('Scan again', flow.reset)}
        </View>}
        {state.stage !== 'success' && state.stage !== 'joining' && button('Cancel', () => { flow.cancel(); router.back(); })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: Colors.offWhite },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: '700', color: Colors.navy },
  subtitle: { fontSize: 16, color: Colors.textSecondary, marginVertical: 12, lineHeight: 24 },
  camera: { width: '100%', aspectRatio: 1, borderRadius: 16, overflow: 'hidden' },
  card: { padding: 20, borderRadius: 16, backgroundColor: Colors.white },
  button: { backgroundColor: Colors.navy, padding: 16, borderRadius: 12, marginVertical: 6, alignItems: 'center' },
  buttonText: { color: Colors.white, fontSize: 16, fontWeight: '600' },
  error: { color: Colors.error, fontSize: 16, marginVertical: 16 },
});
