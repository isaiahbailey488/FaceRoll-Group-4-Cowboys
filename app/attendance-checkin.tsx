import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  AppState,
  Linking,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/Colors';
import { useFacePrivacy } from '../hooks/useFacePrivacy';
import { useCaptureCamera } from '../hooks/useCaptureCamera';
import { useCheckInLocation } from '../hooks/useCheckInLocation';
import FacePrivacyGate from '../components/FacePrivacyGate';
import { getFacePrivacyProfile } from '../services/auth';
import { checkInAccessState } from '../shared/face-privacy';
import ScanTipsCard from '../components/ScanTipsCard';
import FaceCaptureGuide, { FaceCaptureControls, useFaceGuideLayout } from '../components/FaceCaptureGuide';
import {
  getActiveSessions,
  Session,
} from '../services/attendance';
import { getCurrentUser, getStudentDisplayName, getUserProfile, UserProfile } from '../services/auth';
import {
  discardTemporaryCameraFile,
  FaceScanFeedback,
  NOT_RECOGNIZED_FEEDBACK,
  checkInAttendance,
  RecognitionApiError,
  AUTH_ERROR_CODES,
  scanFeedbackForError,
} from '../services/recognition';
import type { CheckInLocation, CheckInSuccess } from '../shared/checkin-contract';
import { locationFeedback, LocationCaptureError } from '../shared/checkin-location';

type CheckInState = 'idle' | 'capturing' | 'locating' | 'processing' | 'success' | 'not_recognized' | 'error' | 'no_session';

// After this many consecutive failures, offer re-enrollment or a manual check-in.
const MAX_FAILED_ATTEMPTS = 3;

const PHOTO_REJECTED_CODES = new Set([
  'no_face_detected',
  'multiple_faces_detected',
  'invalid_face_image',
]);

export default function AttendanceCheckInScreen() {
  const router = useRouter();
  const guide = useFaceGuideLayout();
  const privacy = useFacePrivacy();
  const access = checkInAccessState(privacy.profile);
  const locationOnly = access === 'location_only';
  const usesFace = access === 'face_location';
  const checkInReady = locationOnly || usesFace;
  const focused = useRef(false);
  const cameraRef = useRef<CameraView>(null);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const initialCamera = useRef<string | null>(null);
  const permissionAttempt = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const [permission, requestPermission, getCameraPermission] = useCameraPermissions();
  const [checkInState, setCheckInState] = useState<CheckInState>('idle');
  const [statusMessage, setStatusMessage] = useState('Position your face within the oval');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [loadingSession, setLoadingSession] = useState(true);
  const [failure, setFailure] = useState<FaceScanFeedback | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [askedInstructor, setAskedInstructor] = useState(false);
  const [showTips, setShowTips] = useState(true);
  const [verifiedResult, setVerifiedResult] = useState<CheckInSuccess | null>(null);
  const sessionForLocation = activeSessions.find(session => session.courseId === selectedCourseId) || activeSession;
  const savedRequirement = sessionForLocation?.locationRequirement;
  const locationRequirement = savedRequirement?.kind === 'required' ? savedRequirement : { kind: 'unavailable' as const };
  const location = useCheckInLocation(`${privacy.profile?.uid || ''}:${sessionForLocation?.sessionId || ''}:${privacy.profile?.faceConsentRevision ?? ''}`,
    locationRequirement, checkInReady &&
      !loadingSession && Boolean(sessionForLocation) && privacy.profile?.uid === getCurrentUser()?.uid &&
      checkInState !== 'success' && checkInState !== 'no_session', true);
  const camera = useCaptureCamera(usesFace && permission?.granted === true && !loadingSession &&
    Boolean(activeSession) && location.hasPreparedLocation);
  const contextKey = JSON.stringify([privacy.profile?.uid, privacy.profile?.faceConsentRevision,
    sessionForLocation?.sessionId, sessionForLocation?.courseId, locationRequirement, access]);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const cancelAttempt = useCallback(() => {
    const previous = attempt.current;
    attempt.current = null;
    previous?.abort();
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => { focused.current = false; initialCamera.current = null; permissionAttempt.current = null; cancelAttempt(); };
  }, [cancelAttempt]));
  useEffect(() => {
    if (attempt.current) camera.cancel();
    cancelAttempt();
    setCheckInState(previous => ['capturing', 'locating', 'processing', 'success'].includes(previous) ? 'idle' : previous);
    setVerifiedResult(null);
    if (redirectTimer.current) clearTimeout(redirectTimer.current);
  }, [contextKey, access, cancelAttempt, camera.cancel]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') cancelAttempt(); });
    return () => subscription.remove();
  }, [cancelAttempt]);

  useEffect(() => {
    if (!camera.screenActive || !checkInReady) {
      setCheckInState(previous => ['capturing', 'locating', 'processing'].includes(previous) ? 'idle' : previous);
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    }
  }, [camera.screenActive, checkInReady]);

  useEffect(() => () => {
    if (redirectTimer.current) clearTimeout(redirectTimer.current);
  }, []);

  const loadSessionData = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoadingSession(true);
    try {
      const user = getCurrentUser();
      if (!user) return;

      const [userProfile, sessions] = await Promise.all([
        getUserProfile(user.uid),
        getActiveSessions(user.uid),
      ]);
      if (generation !== loadGeneration.current || getCurrentUser()?.uid !== user.uid) return;

      setProfile(userProfile);

      if (sessions.length > 0) {
        setActiveSessions(sessions);
        setActiveSession(sessions[0]);
        setSelectedCourseId(sessions[0].courseId || '');
        setCheckInState('idle');
      } else {
        setActiveSessions([]);
        setActiveSession(null);
        setSelectedCourseId('');
        setCheckInState('no_session');
        setStatusMessage('No active class session found.\nAsk your instructor to start a session.');
      }
    } catch (error: any) {
      if (generation !== loadGeneration.current) return;
      setCheckInState('no_session');
    } finally {
      if (generation === loadGeneration.current) setLoadingSession(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void loadSessionData();
    return () => { loadGeneration.current += 1; };
  }, [loadSessionData, privacy.profile?.uid]));

  useEffect(() => {
    if (!usesFace || !location.hasPreparedLocation) return;
    const listener = AppState.addEventListener('change', next => {
      if (!focused.current) return;
      if (next === 'background') initialCamera.current = contextKey;
      // Query permission after Settings; never request it or resume sensors here.
      if (next === 'active') void getCameraPermission().catch(() => {});
    });
    return () => listener.remove();
  }, [usesFace, location.hasPreparedLocation, contextKey, getCameraPermission]);

  useEffect(() => {
    if (camera.screenActive && usesFace && location.hasPreparedLocation && permission && !permission.granted &&
        permission.canAskAgain !== false && permissionAttempt.current !== contextKey) {
      permissionAttempt.current = contextKey;
      void requestPermission();
    }
  }, [permission, usesFace, location.hasPreparedLocation, camera.screenActive, requestPermission, contextKey]);

  useEffect(() => {
    if (usesFace && permission?.granted && location.hasPreparedLocation && !loadingSession && !showTips &&
        camera.screenActive && initialCamera.current === null) {
      initialCamera.current = contextKey;
      if (!camera.active) camera.start();
    }
  }, [usesFace, permission?.granted, location.hasPreparedLocation, loadingSession, showTips, camera.screenActive, contextKey]);

  useEffect(() => {
    switch (checkInState) {
      case 'idle':
        setStatusMessage(locationOnly ? 'Tap below to check in. Your location is collected automatically.'
          : access === 'enrollment_required' ? 'Enroll your face, or choose location-only check-in in Profile & Settings.'
          : 'Position your face within the oval');
        break;
      case 'capturing':
        setStatusMessage('Hold still...');
        break;
      case 'processing':
        setStatusMessage('Verifying your check-in...');
        break;
      case 'locating':
        setStatusMessage('Getting a fresh classroom location...');
        break;
      case 'success':
        setStatusMessage(`${verifiedResult?.duplicate ? 'Already recorded' : 'Checked in'} as ${verifiedResult?.status === 'late' ? 'Late' : 'Present'}.`);
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
  }, [checkInState, verifiedResult, locationOnly, access]);

  const recordFailure = (feedback: FaceScanFeedback, state: 'not_recognized' | 'error') => {
    setFailure(feedback);
    setFailedAttempts((count) => count + 1);
    setCheckInState(state);
  };

  const resetFailures = () => {
    setFailure(null);
    setFailedAttempts(0);
    setAskedInstructor(false);
  };

  const handleCheckIn = async () => {
    if (usesFace && showTips) return;
    if (attempt.current || location.state === 'collecting') return;
    if (!checkInReady) return;
    if (checkInState !== 'idle' && checkInState !== 'not_recognized' && checkInState !== 'error') return;

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

    if (!locationOnly && !privacy.profile?.faceEnrolled) {
      camera.stop();
      Alert.alert(
        'Face Not Enrolled',
        'Facial recognition is on. Enroll in Profile & Settings before using face check-in, or turn on Opt Out of Facial Recognition to use location only.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Enroll Now', onPress: () => router.push('/face-enrollment') },
        ]
      );
      return;
    }

    const selectedSession = sessionForLocation;
    if (!selectedSession || privacy.profile?.uid !== user.uid) return;
    if (locationRequirement.kind === 'unavailable') {
      location.reportError('location_policy_unavailable');
      return;
    }
    let operation: ReturnType<typeof camera.beginOperation> = null;
    const controller = new AbortController();
    attempt.current = controller;
    const selectedContext = contextKey;
    const isCurrent = () => !controller.signal.aborted && focused.current && AppState.currentState === 'active' &&
      (!operation || operation.isCurrent()) &&
      currentContext.current === selectedContext && getCurrentUser()?.uid === user.uid;
    setCheckInState(locationOnly ? 'processing' : 'capturing');
    setVerifiedResult(null);

    let capturedImage: string | null = null;
    let capturedLocation: CheckInLocation | null = null;
    let retainLocationForRetake = false;
    try {
      setAskedInstructor(false);
      const consent = await getFacePrivacyProfile(user.uid);
      if (!isCurrent()) return;
      if (checkInAccessState(consent) !== access) { camera.stop(); setCheckInState('idle'); return; }
      capturedLocation = location.getSample();
      if (!capturedLocation) {
        setCheckInState('locating');
        capturedLocation = await location.collect();
        if (!isCurrent()) return;
        if (!capturedLocation) { setFailure(null); setCheckInState('error'); return; }
      }
      if (!locationOnly) {
        if (!camera.active) { retainLocationForRetake = true; camera.start(); setCheckInState('idle'); return; }
        if (!camera.ready || !cameraRef.current) { retainLocationForRetake = true; setCheckInState('idle'); return; }
        operation = camera.beginOperation();
        if (!operation) { setCheckInState('idle'); return; }
        setCheckInState('capturing');
        if (!cameraRef.current) { camera.stop(); setCheckInState('idle'); return; }
        const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.8, skipProcessing: false });
        discardTemporaryCameraFile(photo?.uri);
        if (!isCurrent()) return;
        // Keep the foreground preview mounted for retakes. Success and the
        // screen/consent lifecycle release it; capture does not stop it.
        if (!photo?.base64) throw new Error('Failed to capture image.');
        capturedImage = photo.base64;
      }
      setCheckInState('processing');

      const latest = await getFacePrivacyProfile(user.uid);
      if (!isCurrent()) return;
      if (checkInAccessState(latest) !== access || latest.faceConsentRevision !== consent.faceConsentRevision) {
        camera.stop();
        setCheckInState('idle');
        return;
      }

      if (locationRequirement.kind === 'required') {
        capturedLocation = location.getSample();
        if (!capturedLocation) {
          setCheckInState('locating');
          capturedLocation = await location.collect();
          if (!isCurrent()) return;
          if (!capturedLocation) {
            setFailedAttempts(0);
            setFailure({ title: 'Location needed', hint: 'Get a fresh, accurate location, then try checking in again.' });
            setCheckInState('error');
            return;
          }
        }
      }
      setCheckInState('processing');
      const submitResult = await checkInAttendance({ schemaVersion: 1, sessionId: selectedSession.sessionId,
        image: capturedImage, location: capturedLocation }, {
        expectedUid: user.uid, expectedCourseId: selectedSession.courseId, signal: controller.signal,
      });
      if (!isCurrent()) return;

      camera.stop();
      resetFailures();
      setVerifiedResult(submitResult);
      setCheckInState('success');
      redirectTimer.current = setTimeout(() => {
        if (isCurrent()) router.back();
      }, 2500);

      if (submitResult.duplicate) {
        Alert.alert('Already Checked In', 'You have already checked in for this session.');
      }
    } catch (error: any) {
      if (!isCurrent()) return;
      const feedback = scanFeedbackForError(error, 'Check-in failed');
      if (String(error?.code || '').startsWith('location_')) {
        location.reportError(error.code);
        setFailedAttempts(0);
        setFailure(feedback);
        setCheckInState('error');
      } else if (error instanceof RecognitionApiError && error.code === 'not_enrolled') {
        camera.stop();
        setFailure(feedback);
        setCheckInState('error');
        Alert.alert('Face Not Enrolled', error.message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Enroll Now', onPress: () => router.push('/face-enrollment') },
        ]);
      } else if (error instanceof RecognitionApiError && AUTH_ERROR_CODES.has(error.code)) {
        camera.stop();
        setFailure(feedback);
        setCheckInState('error');
        Alert.alert('Verification Blocked', error.message);
      } else {
        const photoRejected = error instanceof RecognitionApiError &&
          (PHOTO_REJECTED_CODES.has(error.code) || error.code === 'face_not_recognized');
        if (photoRejected) {
          retainLocationForRetake = true;
          recordFailure(error.code === 'face_not_recognized' ? NOT_RECOGNIZED_FEEDBACK : feedback, 'not_recognized');
        }
        else { setFailedAttempts(0); setFailure(feedback); setCheckInState('error'); }
      }
    } finally {
      capturedImage = null;
      capturedLocation = null;
      if (attempt.current === controller) {
        attempt.current = null;
        // Reuse a still-fresh, same-context reading while the camera becomes
        // ready or after a photo/face rejection. Keep its original expiry.
        if (!retainLocationForRetake || !isCurrent() || !location.getSample()) location.releaseSample();
      }
      operation?.finish();
    }
  };

  const handleClose = () => {
    cancelAttempt();
    location.clear();
    camera.cancel();
    router.back();
  };

  if (access === 'loading' || access === 'deletion_pending') return <FacePrivacyGate state={privacy.state} unavailable={privacy.unavailable} retry={privacy.retry} />;

  if (usesFace && location.hasPreparedLocation && !permission) {
    return (
      <View style={styles.permissionContainer}>
        <StatusBar style="dark" />
        <ActivityIndicator color={Colors.navy} size="large" />
      </View>
    );
  }

  if (usesFace && location.hasPreparedLocation && !permission?.granted) {
    return (
      <SafeAreaView style={styles.permissionContainer}>
        <StatusBar style="dark" />
        <Ionicons name="camera-outline" size={60} color={Colors.navy} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionText}>
          FaceRoll needs camera access to verify your identity for attendance check-in.
        </Text>
        <TouchableOpacity style={styles.permissionButton} onPress={() => {
          if (permission?.canAskAgain === false) {
            initialCamera.current = contextKey;
            void Linking.openSettings().catch(() => Alert.alert('Open phone settings', 'Allow camera access for FaceRoll in Settings, then return.'));
          } else void requestPermission();
        }}>
          <Text style={styles.permissionButtonText}>{permission?.canAskAgain === false ? 'Open Settings' : 'Grant Camera Access'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={styles.skipText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const isProcessing = checkInState === 'capturing' || checkInState === 'locating' || checkInState === 'processing';
  const isSuccess = checkInState === 'success';
  const isNoSession = checkInState === 'no_session';
  const isFailed = checkInState === 'not_recognized' || checkInState === 'error';
  const showRecoveryOptions = usesFace && isFailed && failedAttempts >= MAX_FAILED_ATTEMPTS;
  const courseLabel = activeSession?.courseName || activeSession?.courseId || 'this class';
  const locationIssue = !loadingSession && !isNoSession && checkInReady
    ? locationRequirement.kind === 'unavailable' ? locationFeedback(new LocationCaptureError('location_policy_unavailable'))
      : location.state === 'error' ? location.feedback : null
    : null;
  const feedback: FaceScanFeedback | null = !isFailed
    ? locationIssue
    : askedInstructor
      ? {
          title: 'Ask your instructor',
          hint: `Let your instructor know face check-in isn't working for you. They can mark you present for ${courseLabel} manually.`,
        }
      : locationIssue || failure;

  return (
    <View style={styles.container} onLayout={guide.onLayout}>
      <StatusBar style="light" />

      {camera.active && !isSuccess && !isNoSession && (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={'front' as CameraType}
          onCameraReady={camera.onReady}
          onMountError={() => {
            camera.stop();
            setFailure({ title: 'Camera unavailable', hint: 'Could not start the camera. Tap Try Again to reopen it.' });
            setCheckInState('error');
          }}
        />
      )}

      {usesFace && !isNoSession && !loadingSession && <FaceCaptureGuide frame={guide.frame}
        success={isSuccess} error={checkInState === 'not_recognized'} />}

      <View style={[styles.overlay, isNoSession && styles.overlayDark]}>

        <SafeAreaView style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.userInfoLabel} numberOfLines={1}>
              {profile ? getStudentDisplayName(profile, profile.email) : ''}
            </Text>
            {activeSessions.length > 0 && !isNoSession && (
              <View style={styles.coursePickerContainer}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.courseChipsRow}>
                  {activeSessions.map((s) => {
                    const selected = selectedCourseId === s.courseId;
                    return (
                      <TouchableOpacity
                        key={s.sessionId}
                        style={[styles.courseChip, selected && styles.courseChipSelected]}
                        disabled={isProcessing || isSuccess}
                        onPress={() => {
                          setSelectedCourseId(s.courseId || '');
                          setActiveSession(s);
                        }}
                      >
                        <Text numberOfLines={1} style={[styles.courseChipText, selected && styles.courseChipTextSelected]}>
                          {s.courseName || s.courseId || 'Unknown Course'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}
          </View>
          <View style={styles.headerActions}>
            {usesFace && !isNoSession && (
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => setShowTips(true)}
                disabled={isProcessing}
                accessibilityRole="button"
                accessibilityLabel="Show scanning tips"
              >
                <Ionicons name="bulb-outline" size={20} color={Colors.white} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.closeButton}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close check-in"
            >
              <Ionicons name="close" size={22} color={Colors.white} />
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        <FaceCaptureControls frame={usesFace && !isNoSession ? guide.frame : undefined}>


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
            {loadingSession || location.state === 'collecting' ? (
              <ActivityIndicator color={Colors.white} size="large" />
            ) : !usesFace ? <Ionicons name="location-outline" size={80} color={Colors.white} /> : null}

            {feedback ? (
              <View style={styles.feedbackBlock}>
                <Text style={styles.feedbackTitle}>{feedback.title}</Text>
                <Text
                  style={[
                    styles.statusText,
                    styles.feedbackHint,
                    !askedInstructor && styles.statusTextError,
                  ]}
                >
                  {feedback.hint}
                </Text>
              </View>
            ) : (
              <Text
                style={[
                  styles.statusText,
                  isSuccess && styles.statusTextSuccess,
                  isFailed && styles.statusTextError,
                ]}
              >
                {!location.initialCollectionComplete && checkInReady ? 'Getting your classroom location…' : statusMessage}
              </Text>
            )}
            {locationIssue?.action === 'settings' && <TouchableOpacity style={styles.retryButton}
              onPress={() => { void Linking.openSettings().catch(() => Alert.alert('Open phone settings', 'Check FaceRoll location permission and Location Services in Settings.')); }}>
              <Text style={styles.retryButtonText}>Open Settings</Text>
            </TouchableOpacity>}
            {locationIssue?.action === 'reload' && <TouchableOpacity style={styles.retryButton}
              onPress={() => { location.clear(); void loadSessionData(); }}>
              <Text style={styles.retryButtonText}>Reload session</Text>
            </TouchableOpacity>}
            {access === 'enrollment_required' && <View style={styles.recoveryActions}>
              <TouchableOpacity style={styles.recoveryPrimaryButton}
                onPress={() => { location.clear(); camera.cancel(); router.push('/face-enrollment'); }}>
                <Text style={styles.recoveryPrimaryText}>Enroll face</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.recoverySecondaryButton}
                onPress={() => { location.clear(); camera.cancel(); router.push('/(tabs)/profile'); }}>
                <Text style={styles.recoverySecondaryText}>Profile & Settings</Text>
              </TouchableOpacity>
            </View>}
          </View>
        )}

        {!isNoSession && (
          <View style={styles.bottomArea}>
            {isProcessing ? (
              <View style={styles.processingContainer}>
                <ActivityIndicator size="large" color={Colors.white} />
                <Text style={styles.processingText}>
                  {checkInState === 'capturing' ? 'Capturing...' : checkInState === 'locating' ? 'Getting location...' : 'Verifying check-in...'}
                </Text>
              </View>
            ) : isSuccess ? (
              <View style={styles.successContainer}>
                <Ionicons name="checkmark-circle" size={64} color={Colors.cameraSuccess} />
                <Text style={styles.successText}>Attendance Recorded!</Text>
                {verifiedResult?.locationStatus === 'in_zone' && <Text style={styles.processingText}>Classroom location verified</Text>}
              </View>
            ) : access === 'enrollment_required' ? null : showRecoveryOptions ? (
              <View style={styles.recoveryActions}>
                <TouchableOpacity
                  style={styles.recoveryPrimaryButton}
                  onPress={() => router.push('/face-enrollment')}
                  activeOpacity={0.85}
                >
                  <Ionicons name="camera-outline" size={18} color={Colors.white} style={{ marginRight: 8 }} />
                  <Text style={styles.recoveryPrimaryText}>Re-enroll face</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.recoverySecondaryButton}
                  onPress={() => setAskedInstructor(true)}
                  activeOpacity={0.85}
                >
                  <Ionicons name="hand-left-outline" size={18} color={Colors.white} style={{ marginRight: 8 }} />
                  <Text style={styles.recoverySecondaryText}>Ask instructor to mark me present</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleCheckIn} style={styles.recoveryRetryButton}>
                  <Text style={styles.recoveryRetryText}>Try again</Text>
                </TouchableOpacity>
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
                  disabled={loadingSession || location.state === 'collecting' ||
                    (!location.initialCollectionComplete && !location.hasPreparedLocation) || (usesFace && showTips) ||
                    (camera.active && !camera.ready)}
                  accessibilityRole="button"
                  accessibilityLabel={locationOnly ? 'Check in with location' : !location.hasPreparedLocation ? 'Try check-in again'
                    : camera.active ? 'Take check-in photo' : 'Resume check-in camera'}
                >
                  {locationOnly ? <Ionicons name="location-outline" size={32} color={Colors.navy} /> : <View style={styles.captureButtonInner} />}
                </TouchableOpacity>
                <Text style={styles.checkInLabel}>
                  {location.state === 'collecting' || (!location.initialCollectionComplete && checkInReady) ? 'Getting ready…'
                    : locationOnly ? 'Check In with Location' : !location.hasPreparedLocation ? 'Try Again'
                    : checkInState === 'not_recognized' || checkInState === 'error'
                    ? 'Try Again'
                    : !camera.active && !loadingSession && privacy.profile?.faceEnrolled ? 'Resume Camera'
                    : camera.active && !camera.ready ? 'Starting Camera…' : 'Check In'}
                </Text>
              </View>
            )}
          </View>
        )}

        </FaceCaptureControls>
      </View>
      {usesFace && showTips && camera.screenActive && !isNoSession && !loadingSession && location.initialCollectionComplete && !isProcessing && !isSuccess
        ? <ScanTipsCard modal onDismiss={() => setShowTips(false)} /> : null}
    </View>
  );
}

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
    backgroundColor: Colors.offWhite,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  permissionTitle: {
    color: Colors.green,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 20,
    marginBottom: 10,
    textAlign: 'center',
  },
  permissionText: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
  },
  permissionButton: {
    backgroundColor: Colors.navy,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
  },
  permissionButtonText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  skipText: {
    color: Colors.textLink,
    fontSize: 14,
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
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  coursePickerContainer: {
    alignSelf: 'stretch',
    marginTop: 6,
  },
  courseChipsRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 8,
  },
  courseChip: {
    maxWidth: 220,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  courseChipSelected: {
    backgroundColor: Colors.navy,
    borderColor: Colors.navy,
  },
  courseChipText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
  courseChipTextSelected: {
    color: Colors.white,
  },

  guideArea: {
    alignItems: 'center',
    paddingHorizontal: 16,
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
    color: Colors.cameraSuccess,
    fontWeight: '700',
  },
  statusTextError: {
    color: Colors.cameraError,
  },
  feedbackBlock: {
    marginTop: 24,
    alignItems: 'center',
  },
  feedbackTitle: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  feedbackHint: {
    marginTop: 4,
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
    backgroundColor: Colors.navy,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderWidth: 1,
    borderColor: Colors.navy,
  },
  retryButtonText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '600',
  },

  bottomArea: {
    marginTop: 'auto',
    paddingTop: 24,
    paddingBottom: 8,
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
    color: Colors.cameraSuccess,
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
    borderColor: Colors.cameraError,
  },
  recoveryActions: {
    width: '100%',
    paddingHorizontal: 32,
    alignItems: 'center',
  },
  recoveryPrimaryButton: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: Colors.navy,
    borderRadius: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  recoveryPrimaryText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  recoverySecondaryButton: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recoverySecondaryText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  recoveryRetryButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  recoveryRetryText: {
    color: Colors.white,
    fontSize: 13,
    textDecorationLine: 'underline',
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
