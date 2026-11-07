import React from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Colors from '../constants/Colors';
import { LOCATION_DISCLOSURE, LocationRequirement } from '../shared/checkin-location';
import type { useCheckInLocation } from '../hooks/useCheckInLocation';

export default function CheckInLocationCard({ requirement, location, onReload, requiresEnrollment, onEnroll, onPreferences }: {
  requirement: LocationRequirement;
  location: ReturnType<typeof useCheckInLocation>;
  onReload: () => void;
  requiresEnrollment: boolean;
  onEnroll: () => void;
  onPreferences: () => void;
}) {
  const feedback = location.feedback;
  if (requirement.kind === 'not_required' && !feedback && !requiresEnrollment) return null;
  const unavailable = requirement.kind === 'unavailable' || (requirement.kind === 'not_required' && feedback?.action === 'reload');
  const collecting = location.state === 'collecting';
  const ready = location.state === 'ready';
  const title = requiresEnrollment ? 'Choose how to check in' : unavailable ? 'Classroom settings unavailable' : collecting ? 'Getting a fresh location…'
    : ready ? 'Location ready' : feedback?.title || 'Classroom location required';

  const openSettings = async () => {
    try { await Linking.openSettings(); }
    catch { Alert.alert('Open phone settings', 'Open Settings on your phone to check FaceRoll’s location permission and Location Services.'); }
  };

  return <View style={styles.card}>
    <View style={styles.heading}>
      {collecting && <ActivityIndicator color={Colors.navy} size="small" />}
      <Text style={styles.title} accessibilityRole="header" accessibilityLiveRegion="polite">{title}</Text>
    </View>
    <Text style={styles.body}>{requiresEnrollment
      ? 'Facial recognition is on, but your face is not enrolled. Enroll to check in with face and location, or turn facial recognition off in Profile & Settings to use location only.'
      : unavailable ? 'Ask your instructor to start a session with classroom location enabled, then reload.'
      : feedback?.hint || (ready ? 'Your location is ready for this check-in. You can refresh it if needed.' : LOCATION_DISCLOSURE)}</Text>
    <View style={styles.actions}>
      {requiresEnrollment ? <>
        <TouchableOpacity style={styles.button} onPress={onEnroll} accessibilityRole="button"><Text style={styles.label}>Enroll face</Text></TouchableOpacity>
        <TouchableOpacity style={styles.settingsButton} onPress={onPreferences} accessibilityRole="button"><Text style={styles.settingsLabel}>Profile & Settings</Text></TouchableOpacity>
      </> : unavailable ? <TouchableOpacity style={styles.button} onPress={onReload} accessibilityRole="button">
        <Text style={styles.label}>Reload session</Text>
      </TouchableOpacity> : collecting ? <TouchableOpacity style={styles.button} onPress={location.clear} accessibilityRole="button">
        <Text style={styles.label}>Cancel location</Text>
      </TouchableOpacity> : <>
        <TouchableOpacity style={styles.button} onPress={() => { void location.collect(); }} accessibilityRole="button">
          <Text style={styles.label}>{ready || location.state === 'expired' || location.state === 'error' ? 'Refresh location' : 'Get location'}</Text>
        </TouchableOpacity>
        {feedback?.action === 'settings' && <TouchableOpacity style={styles.settingsButton} onPress={openSettings} accessibilityRole="button">
          <Text style={styles.settingsLabel}>Open Settings</Text>
        </TouchableOpacity>}
        {feedback?.action === 'reload' && <TouchableOpacity style={styles.settingsButton} onPress={onReload} accessibilityRole="button">
          <Text style={styles.settingsLabel}>Reload session</Text>
        </TouchableOpacity>}
      </>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: Colors.offWhite, borderRadius: 14, padding: 12, marginHorizontal: 16, gap: 8 },
  heading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  title: { color: Colors.green, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  body: { color: Colors.textSecondary, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  button: { backgroundColor: Colors.navy, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10,
    minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  label: { color: Colors.white, fontSize: 13, fontWeight: '600' },
  settingsButton: { paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
  settingsLabel: { color: Colors.textLink, fontSize: 13, fontWeight: '600' },
});
