import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  Dimensions,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/Colors';
import {
  recognizeFaceForCheckIn,
  submitAttendance,
  getActiveSessions,
  Session,
} from '../services/attendance';
import { getCurrentUser, getUserProfile, UserProfile } from '../services/auth';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const OVAL_WIDTH = SCREEN_WIDTH * 0.55;
const OVAL_HEIGHT = OVAL_WIDTH * 1.3;

type CheckInState = 'idle' | 'capturing' | 'processing' | 'success' | 'not_recognized' | 'error' | 'no_session';

export default function AttendanceCheckInScreen() {
  const router = useRouter();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [checkInState, setCheckInState] = useState<CheckInState>('idle');
  const [statusMessage, setStatusMessage] = useState('Position your face within the oval');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [loadingSession, setLoadingSession] = useState(true);

  const loadSessionData = useCallback(async () => {
    try {
      const user = getCurrentUser();
      if (!user) return;

      const [userProfile, sessions] = await Promise.all([
        getUserProfile(user.uid),
        getActiveSessions(),
      ]);

      setProfile(userProfile);

      if (sessions.length > 0) {
        setActiveSessions(sessions);
        setActiveSession(sessions[0]);
        setSelectedCourseId(sessions[0].courseId || '');
      } else {
        setCheckInState('no_session');
        setStatusMessage('No active class session found.\nAsk your instructor to start a session.');
      }
    } catch (error: any) {
      if (__DEV__) {
        console.warn('[checkin] session load skipped:', error?.code || error?.message || error);
      }
      setCheckInState('no_session');
    } finally {
      setLoadingSession(false);
    }
  }, []);

  useEffect(() => {
    loadSessionData();
  }, [loadSessionData]);

  useEffect(() => {
    if (permission && !permission.granted) {
      requestPermission();
    }
  }, [permission]);

  useEffect(() => {
    switch (checkInState) {
      case 'idle':
        setStatusMessage('Position your face within the oval');
        break;
      case 'capturing':
        setStatusMessage('Hold still...');
        break;
      case 'processing':
        setStatusMessage('Recognizing your face...');
        break;
      case 'success':
        setStatusMessage('Check-in successful!');
        break;
      case 'not_recognized':
        setStatusMessage('Face not recognized. Please try again or contact your instructor.');
        break;
      case 'error':
        setStatusMessage('Check-in failed. Please try again.');
        break;
      case 'no_session':
        setStatusMessage('No active class session found.\nAsk your instructor to start a session.');
        break;
    }
  }, [checkInState]);

  const handleCheckIn = async () => {
    if (checkInState !== 'idle' && checkInState !== 'not_recognized' && checkInState !== 'error') return;
    if (!cameraRef.current) return;

    const user = getCurrentUser();
    if (!user) {
      Alert.alert('Error', 'You must be logged in to check in.');
      return;
    }

    if (!activeSession) {
      Alert.alert(
        'No Active Session',
        'Your instructor has not started an attendance session yet. Please wait and try again.'
      );
      return;
    }

    if (profile?.optOutFlag) {
      Alert.alert(
        'Facial Recognition Opted Out',
        'You have opted out of facial recognition. Your instructor will mark your attendance manually.'
      );
      return;
    }

    if (!profile?.faceEnrolled) {
      Alert.alert(
        'Face Not Enrolled',
        'You need to enroll your face before checking in. Go to Profile → Enroll Face.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Enroll Now', onPress: () => router.push('/face-enrollment') },
        ]
      );
      return;
    }

    try {
      setCheckInState('capturing');

      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.8,
        skipProcessing: false,
      });

      if (!photo?.base64) {
        throw new Error('Failed to capture image.');
      }

      setCheckInState('processing');

      const sessionForCourse =
        activeSessions.find((s) => s.courseId === selectedCourseId) || activeSession;

      if (!sessionForCourse) {
        setCheckInState('error');
        Alert.alert('Error', 'Could not determine active session for selected course.');
        return;
      }

      const result = await recognizeFaceForCheckIn(photo.base64, sessionForCourse.sessionId);

      if (!result.success || !result.recognized) {
        setCheckInState('not_recognized');
        return;
      }

      const sessionStart = typeof sessionForCourse.startTime === 'string'
        ? new Date(sessionForCourse.startTime)
        : (sessionForCourse.startTime as any).toDate?.() ?? new Date();

      const gracePeriodMs = (sessionForCourse.gracePeriodMinutes ?? 10) * 60 * 1000;
      const now = new Date();
      const attendanceStatus = now.getTime() - sessionStart.getTime() > gracePeriodMs
        ? 'late'
        : 'present';

      const submitResult = await submitAttendance({
        uid: user.uid,
        sessionId: sessionForCourse.sessionId,
        courseId: sessionForCourse.courseId,
        status: attendanceStatus,
        method: 'face recognition',
      });

      if (submitResult.duplicate) {
        setCheckInState('idle');
        Alert.alert('Already Checked In', 'You have already checked in for this session.');
        return;
      }

      setCheckInState('success');

      setTimeout(() => {
        router.back();
      }, 2500);
    } catch (error: any) {
      console.error('Check-in error:', error);
      setCheckInState('error');
    }
  };

  const handleClose = () => {
    if (checkInState === 'processing' || checkInState === 'capturing') return;
    router.back();
  };

  if (!permission) {
    return (
      <View style={styles.permissionContainer}>
        <ActivityIndicator color={Colors.white} size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.permissionContainer}>
        <Ionicons name="camera-outline" size={60} color={Colors.white} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionText}>
          FaceRoll needs camera access to verify your identity for attendance check-in.
        </Text>
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Grant Camera Access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={styles.skipText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const isProcessing = checkInState === 'capturing' || checkInState === 'processing';
  const isSuccess = checkInState === 'success';
  const isNoSession = checkInState === 'no_session';

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {!isNoSession && (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={'front' as CameraType}
        />
      )}

      <View style={[styles.overlay, isNoSession && styles.overlayDark]}>

        <SafeAreaView style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.userInfoLabel}>
              {profile ? profile.displayName : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={handleClose}
            disabled={isProcessing}
          >
            <Ionicons name="close" size={22} color={Colors.white} />
          </TouchableOpacity>
        </SafeAreaView>

        {activeSessions.length > 0 && !isNoSession && (
          <View style={styles.coursePickerContainer}>
            <Text style={styles.coursePickerLabel}>Select Course</Text>
            <View style={styles.courseChipsRow}>
              {activeSessions.map((s) => {
                const selected = selectedCourseId === s.courseId;
                return (
                  <TouchableOpacity
                    key={s.sessionId}
                    style={[styles.courseChip, selected && styles.courseChipSelected]}
                    onPress={() => {
                      setSelectedCourseId(s.courseId || '');
                      setActiveSession(s);
                    }}
                  >
                    <Text style={[styles.courseChipText, selected && styles.courseChipTextSelected]}>
                      {s.courseName || s.courseId || 'Unknown Course'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {isNoSession ? (
          <View style={styles.noSessionContainer}>
            <Ionicons name="calendar-outline" size={64} color={Colors.white} style={{ opacity: 0.5 }} />
            <Text style={styles.noSessionTitle}>No Active Session</Text>
            <Text style={styles.noSessionText}>
              Your instructor hasn't started an attendance session yet.{'\n'}
              Please wait and try again.
            </Text>
            <TouchableOpacity style={styles.retryButton} onPress={loadSessionData}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.guideArea}>
            {loadingSession ? (
              <ActivityIndicator color={Colors.white} size="large" />
            ) : (
              <View style={styles.bracketsContainer}>
                <View style={[styles.bracket, styles.bracketTopLeft]} />
                <View style={[styles.bracket, styles.bracketTopRight]} />
                <View style={[styles.bracket, styles.bracketBottomLeft]} />
                <View style={[styles.bracket, styles.bracketBottomRight]} />

                <View
                  style={[
                    styles.ovalGuide,
                    isSuccess && styles.ovalGuideSuccess,
                    checkInState === 'not_recognized' && styles.ovalGuideError,
                  ]}
                />
              </View>
            )}

            <Text
              style={[
                styles.statusText,
                isSuccess && styles.statusTextSuccess,
                (checkInState === 'not_recognized' || checkInState === 'error') && styles.statusTextError,
              ]}
            >
              {statusMessage}
            </Text>
          </View>
        )}

        {!isNoSession && (
          <View style={styles.bottomArea}>
            {isProcessing ? (
              <View style={styles.processingContainer}>
                <ActivityIndicator size="large" color={Colors.white} />
                <Text style={styles.processingText}>
                  {checkInState === 'capturing' ? 'Capturing...' : 'Verifying...'}
                </Text>
              </View>
            ) : isSuccess ? (
              <View style={styles.successContainer}>
                <Ionicons name="checkmark-circle" size={64} color={Colors.green} />
                <Text style={styles.successText}>Attendance Recorded!</Text>
              </View>
            ) : (
              <View style={styles.captureSection}>
                <TouchableOpacity
                  style={[
                    styles.captureButton,
                    (checkInState === 'not_recognized' || checkInState === 'error') && styles.captureButtonRetry,
                  ]}
                  onPress={handleCheckIn}
                  activeOpacity={0.8}
                  disabled={loadingSession}
                >
                  <View style={styles.captureButtonInner} />
                </TouchableOpacity>
                <Text style={styles.checkInLabel}>
                  {checkInState === 'not_recognized' || checkInState === 'error'
                    ? 'Try Again'
                    : 'Check In'}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const BRACKET_SIZE = 28;
const BRACKET_THICK = 3;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cameraBackground,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  overlayDark: {
    backgroundColor: Colors.cameraBackground,
  },

  permissionContainer: {
    flex: 1,
    backgroundColor: Colors.cameraBackground,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  permissionTitle: {
    color: Colors.white,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 20,
    marginBottom: 10,
    textAlign: 'center',
  },
  permissionText: {
    color: Colors.cameraGuide,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
    opacity: 0.8,
  },
  permissionButton: {
    backgroundColor: Colors.white,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  permissionButtonText: {
    color: Colors.navy,
    fontSize: 15,
    fontWeight: '700',
  },
  skipText: {
    color: Colors.cameraGuide,
    fontSize: 14,
    opacity: 0.7,
    textDecorationLine: 'underline',
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 8,
  },
  headerLeft: {
    flex: 1,
  },
  userInfoLabel: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '600',
    opacity: 0.9,
  },
  profileSettingsLabel: {
    color: Colors.white,
    fontSize: 11,
    opacity: 0.6,
    marginTop: 1,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  coursePickerContainer: {
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  coursePickerLabel: {
    color: Colors.white,
    fontSize: 12,
    opacity: 0.8,
    marginBottom: 6,
  },
  courseChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  courseChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  courseChipSelected: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderColor: Colors.white,
  },
  courseChipText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
  courseChipTextSelected: {
    color: Colors.navy,
  },

  guideArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bracketsContainer: {
    width: OVAL_WIDTH + 40,
    height: OVAL_HEIGHT + 40,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  ovalGuide: {
    width: OVAL_WIDTH,
    height: OVAL_HEIGHT,
    borderRadius: OVAL_WIDTH / 2,
    borderWidth: 2,
    borderColor: Colors.cameraGuide,
    backgroundColor: 'transparent',
  },
  ovalGuideSuccess: {
    borderColor: Colors.green,
    borderWidth: 3,
  },
  ovalGuideError: {
    borderColor: '#FF6B6B',
  },
  bracket: {
    position: 'absolute',
  },
  bracketTopLeft: {
    top: 0,
    left: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderTopWidth: BRACKET_THICK,
    borderLeftWidth: BRACKET_THICK,
    borderColor: Colors.cameraGuide,
  },
  bracketTopRight: {
    top: 0,
    right: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderTopWidth: BRACKET_THICK,
    borderRightWidth: BRACKET_THICK,
    borderColor: Colors.cameraGuide,
  },
  bracketBottomLeft: {
    bottom: 0,
    left: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderBottomWidth: BRACKET_THICK,
    borderLeftWidth: BRACKET_THICK,
    borderColor: Colors.cameraGuide,
  },
  bracketBottomRight: {
    bottom: 0,
    right: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderBottomWidth: BRACKET_THICK,
    borderRightWidth: BRACKET_THICK,
    borderColor: Colors.cameraGuide,
  },
  statusText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '500',
    marginTop: 24,
    textAlign: 'center',
    opacity: 0.9,
    paddingHorizontal: 32,
    lineHeight: 22,
  },
  statusTextSuccess: {
    color: Colors.green,
    fontWeight: '700',
  },
  statusTextError: {
    color: '#FF6B6B',
  },

  noSessionContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  noSessionTitle: {
    color: Colors.white,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 10,
  },
  noSessionText: {
    color: Colors.white,
    fontSize: 14,
    textAlign: 'center',
    opacity: 0.7,
    lineHeight: 22,
    marginBottom: 28,
  },
  retryButton: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  retryButtonText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '600',
  },

  bottomArea: {
    paddingBottom: 60,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 140,
  },
  processingContainer: {
    alignItems: 'center',
  },
  processingText: {
    color: Colors.white,
    fontSize: 14,
    marginTop: 12,
    opacity: 0.8,
  },
  successContainer: {
    alignItems: 'center',
  },
  successText: {
    color: Colors.green,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 10,
  },
  captureSection: {
    alignItems: 'center',
  },
  captureButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.cameraButton,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.5)',
    marginBottom: 10,
  },
  captureButtonRetry: {
    borderColor: '#FF6B6B',
  },
  captureButtonInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.cameraButton,
    borderWidth: 2,
    borderColor: Colors.cameraButtonInner,
  },
  checkInLabel: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '600',
    opacity: 0.9,
  },
});
