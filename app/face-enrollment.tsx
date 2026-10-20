import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import Colors from '../constants/Colors';
import { useFacePrivacy } from '../hooks/useFacePrivacy';
import { useCaptureCamera } from '../hooks/useCaptureCamera';
import FacePrivacyGate from '../components/FacePrivacyGate';
import ScanTipsCard from '../components/ScanTipsCard';
import { getCurrentUser, getFacePrivacyProfile } from '../services/auth';
import { faceAccessState } from '../shared/face-privacy';
import {
  discardTemporaryCameraFile,
  enrollFace,
  FaceScanFeedback,
  RecognitionApiError,
  AUTH_ERROR_CODES,
  scanFeedbackForError,
} from '../services/recognition';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const OVAL_WIDTH = SCREEN_WIDTH * 0.55;
const OVAL_HEIGHT = OVAL_WIDTH * 1.3;

const CAPTURE_STEPS = [
  {
    key: 'front',
    label: 'Forward',
    instruction: 'Look straight at the camera and keep your full face visible.',
  },
  {
    key: 'left',
    label: 'Slightly Left',
    instruction: 'Turn slightly left while keeping both eyes visible.',
  },
  {
    key: 'right',
    label: 'Slightly Right',
    instruction: 'Turn slightly right while keeping both eyes visible.',
  },
] as const;

type EnrollmentState =
  | 'idle'
  | 'capturing'
  | 'review'
  | 'processing'
  | 'success'
  | 'error';

const emptyCaptures = (): Array<string | null> => [null, null, null];

export default function FaceEnrollmentScreen() {
  const router = useRouter();
  const privacy = useFacePrivacy();
  const cameraRef = useRef<CameraView>(null);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureRevision = useRef<number | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [enrollState, setEnrollState] = useState<EnrollmentState>('idle');
  const [capturedImages, setCapturedImages] = useState<Array<string | null>>(
    emptyCaptures
  );
  const [activeStep, setActiveStep] = useState(0);
  const [failure, setFailure] = useState<FaceScanFeedback | null>(null);
  const [showTips, setShowTips] = useState(true);
  const camera = useCaptureCamera(privacy.state === 'ready' && permission?.granted === true);

  useEffect(() => {
    if (camera.screenActive && privacy.state === 'ready' && permission && !permission.granted) {
      requestPermission();
    }
  }, [permission, requestPermission, privacy.state, camera.screenActive]);

  useEffect(() => {
    if (!camera.screenActive) {
      setEnrollState(previous => previous === 'capturing' || previous === 'processing'
        ? capturedImages.every(Boolean) ? 'review' : 'idle' : previous);
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    }
  }, [camera.screenActive, capturedImages]);

  useEffect(() => {
    if (privacy.state !== 'ready') {
      setCapturedImages(emptyCaptures());
      captureRevision.current = null;
      setEnrollState('idle');
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    }
  }, [privacy.state]);

  useEffect(
    () => () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    },
    []
  );

  const capturedCount = capturedImages.filter(Boolean).length;
  const allCaptured = capturedCount === CAPTURE_STEPS.length;
  const currentStep = CAPTURE_STEPS[activeStep];
  const isBusy = enrollState === 'capturing' || enrollState === 'processing';
  const isSuccess = enrollState === 'success';
  const isReview = enrollState === 'review' || enrollState === 'error';

  const statusMessage = (() => {
    switch (enrollState) {
      case 'capturing':
        return 'Hold still...';
      case 'review':
        return 'Review your three captures or retake a position.';
      case 'processing':
        return 'Creating three private face embeddings...';
      case 'success':
        return 'Face enrolled successfully!';
      case 'error':
        return failure?.hint ?? 'Enrollment failed. Retake a position or try submitting again.';
      default:
        return currentStep.instruction;
    }
  })();

  const clearCaptures = () => {
    captureRevision.current = null;
    setCapturedImages(emptyCaptures());
    setActiveStep(0);
  };

  const handleCapture = async () => {
    if (privacy.state !== 'ready') return;
    if (enrollState !== 'idle') return;
    if (!camera.active) { camera.start(); return; }
    if (!camera.ready || !cameraRef.current) return;
    if (!getCurrentUser()) {
      Alert.alert('Sign In Required', 'You must be logged in to enroll your face.');
      return;
    }

    const operation = camera.beginOperation();
    if (!operation) return;
    setEnrollState('capturing');
    try {
      const user = getCurrentUser();
      if (!user) { camera.stop(); setEnrollState('idle'); return; }
      const consent = await getFacePrivacyProfile(user.uid);
      if (!operation.isCurrent()) return;
      if (faceAccessState(consent) !== 'ready') { camera.stop(); setEnrollState('idle'); return; }
      const revision = consent.faceConsentRevision ?? 0;
      if (captureRevision.current !== null && captureRevision.current !== revision) {
        clearCaptures();
        camera.stop();
        setEnrollState('idle');
        return;
      }
      captureRevision.current = revision;
      if (!cameraRef.current) { camera.stop(); setEnrollState('idle'); return; }
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.8,
        skipProcessing: false,
      });
      discardTemporaryCameraFile(photo?.uri);
      if (!operation.isCurrent()) return;
      // The final photo is all the hardware we need, even while consent is rechecked.
      const updated = [...capturedImages];
      updated[activeStep] = photo?.base64 || null;
      if (updated.every(Boolean)) camera.stop();
      if (!photo?.base64) {
        throw new Error('Failed to capture image.');
      }

      const latest = await getFacePrivacyProfile(user.uid);
      if (!operation.isCurrent()) return;
      if (faceAccessState(latest) !== 'ready' || (latest.faceConsentRevision ?? 0) !== revision || captureRevision.current !== revision) {
        clearCaptures();
        camera.stop();
        setEnrollState('idle');
        return;
      }
      setCapturedImages(updated);

      const nextMissing = updated.findIndex((image) => !image);
      if (nextMissing >= 0) {
        setActiveStep(nextMissing);
        setEnrollState('idle');
      } else {
        setEnrollState('review');
      }
    } catch (error: any) {
      if (!operation.isCurrent()) return;
      camera.stop();
      if (__DEV__) console.warn('Capture error:', error?.message || error);
      setEnrollState('idle');
      Alert.alert('Capture Failed', error?.message || 'Please try taking the photo again.');
    } finally {
      operation.finish();
    }
  };

  const handleRetake = (index: number) => {
    if (isBusy || isSuccess) return;
    setFailure(null);
    setActiveStep(index);
    setEnrollState('idle');
    camera.start();
  };

  const handleStartOver = () => {
    if (isBusy) return;
    clearCaptures();
    setFailure(null);
    setEnrollState('idle');
    camera.start();
  };

  const handleSubmit = async () => {
    if (privacy.state !== 'ready') return;
    const user = getCurrentUser();
    if (!user) {
      Alert.alert('Sign In Required', 'You must be logged in to enroll your face.');
      return;
    }
    if (!allCaptured) {
      Alert.alert('Three Photos Required', 'Capture all three positions before submitting.');
      return;
    }

    const images = capturedImages.filter((image): image is string => Boolean(image));
    const operation = camera.beginOperation();
    if (!operation) return;
    camera.stop();
    setEnrollState('processing');
    try {
      const consent = await getFacePrivacyProfile(user.uid);
      if (!operation.isCurrent()) return;
      const revision = consent.faceConsentRevision ?? 0;
      if (faceAccessState(consent) !== 'ready' || captureRevision.current !== revision) {
        clearCaptures();
        setEnrollState('idle');
        return;
      }
      setFailure(null);
      const result = await enrollFace(images);
      if (!operation.isCurrent()) return;
      const latest = await getFacePrivacyProfile(user.uid);
      if (!operation.isCurrent()) return;
      if (faceAccessState(latest) !== 'ready' || (latest.faceConsentRevision ?? 0) !== revision) {
        clearCaptures();
        setEnrollState('idle');
        return;
      }
      if (result.sampleCount !== 3 || result.model !== 'Facenet512') {
        throw new RecognitionApiError(
          'invalid_enrollment_response',
          'The recognition server did not confirm three Facenet512 samples.'
        );
      }

      // The API commits enrollment status only while the same consent revision is valid.
      clearCaptures();
      setEnrollState('success');
      redirectTimer.current = setTimeout(() => {
        if (operation.isCurrent()) router.replace('/(tabs)/home');
      }, 1800);
    } catch (error: any) {
      if (!operation.isCurrent()) return;
      if (__DEV__) {
        console.warn('Enrollment error:', error?.code || error?.message || error);
      }
      setFailure(scanFeedbackForError(error, 'Enrollment failed'));
      setEnrollState('error');

      if (error instanceof RecognitionApiError && AUTH_ERROR_CODES.has(error.code)) {
        Alert.alert('Enrollment Failed', error.message);
      }
    } finally {
      operation.finish();
    }
  };

  const handleClose = () => {
    if (isBusy) return;
    camera.stop();
    Alert.alert(
      'Leave Enrollment?',
      'Your unsent captures will be discarded. You can enroll later from your Profile.',
      [
        { text: 'Stay', style: 'cancel', onPress: () => { if (enrollState === 'idle') camera.start(); } },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => {
            camera.cancel();
            clearCaptures();
            router.replace('/(tabs)/home');
          },
        },
      ]
    );
  };

  if (privacy.state !== 'ready') return <FacePrivacyGate state={privacy.state} unavailable={privacy.unavailable} retry={privacy.retry} />;

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
          FaceRoll needs camera access to enroll your face for attendance recognition.
        </Text>
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Grant Camera Access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} style={styles.skipButton}>
          <Text style={styles.skipText}>Skip for Now</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      {camera.active && (enrollState === 'idle' || enrollState === 'capturing') && <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={'front' as CameraType}
        onCameraReady={camera.onReady}
        onMountError={() => {
          camera.stop();
          Alert.alert('Camera Unavailable', 'Could not start the camera. Tap Resume Camera to try again.');
        }}
      />}

      <View style={styles.overlay}>
        <SafeAreaView style={styles.header}>
          <Text style={styles.screenLabel}>Private Face Enrollment</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowTips(true)}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel="Show scanning tips"
            >
              <Ionicons name="bulb-outline" size={20} color={Colors.white} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={handleClose}
              disabled={isBusy}
            >
              <Ionicons name="close" size={22} color={Colors.white} />
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        <View style={styles.progressRow}>
          {CAPTURE_STEPS.map((step, index) => {
            const captured = Boolean(capturedImages[index]);
            const selected = activeStep === index && enrollState === 'idle';
            return (
              <TouchableOpacity
                key={step.key}
                style={[
                  styles.progressStep,
                  captured && styles.progressStepCaptured,
                  selected && styles.progressStepSelected,
                ]}
                disabled={!captured || isBusy || isSuccess}
                onPress={() => handleRetake(index)}
              >
                <Ionicons
                  name={captured ? 'checkmark-circle' : 'ellipse-outline'}
                  size={16}
                  color={captured ? Colors.green : Colors.white}
                />
                <Text style={styles.progressText}>{step.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.guideArea}>
          <View style={styles.bracketsContainer}>
            <View style={[styles.bracket, styles.bracketTopLeft]} />
            <View style={[styles.bracket, styles.bracketTopRight]} />
            <View style={[styles.bracket, styles.bracketBottomLeft]} />
            <View style={[styles.bracket, styles.bracketBottomRight]} />
            <View style={[styles.ovalGuide, isSuccess && styles.ovalGuideSuccess]} />
          </View>
          <Text style={styles.positionTitle}>
            {enrollState === 'error' && failure
              ? failure.title
              : isReview
                ? `${capturedCount} of 3 captured`
                : currentStep.label}
          </Text>
          <Text
            style={[
              styles.statusText,
              isSuccess && styles.statusTextSuccess,
              enrollState === 'error' && styles.statusTextError,
            ]}
          >
            {statusMessage}
          </Text>
        </View>

        <View style={styles.bottomArea}>
          {isBusy ? (
            <View style={styles.processingContainer}>
              <ActivityIndicator size="large" color={Colors.white} />
              <Text style={styles.processingText}>
                {enrollState === 'capturing' ? 'Capturing...' : 'Processing three photos...'}
              </Text>
            </View>
          ) : isSuccess ? (
            <View style={styles.successContainer}>
              <Ionicons name="checkmark-circle" size={64} color={Colors.green} />
              <Text style={styles.successText}>Redirecting to Home...</Text>
            </View>
          ) : isReview ? (
            <View style={styles.reviewActions}>
              <TouchableOpacity style={styles.submitButton} onPress={handleSubmit}>
                <Text style={styles.submitButtonText}>Submit Three Photos</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.startOverButton} onPress={handleStartOver}>
                <Text style={styles.startOverText}>Start Over</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.captureSection}>
              <TouchableOpacity
                style={styles.captureButton}
                onPress={handleCapture}
                activeOpacity={0.8}
                disabled={camera.active && !camera.ready}
                accessibilityRole="button"
                accessibilityLabel={camera.active ? 'Take enrollment photo' : 'Resume enrollment camera'}
              >
                <View style={styles.captureButtonInner} />
              </TouchableOpacity>
              <Text style={styles.captureLabel}>
                {!camera.active ? 'Resume Camera' : !camera.ready ? 'Starting Camera…'
                  : capturedImages[activeStep] ? `Retake ${currentStep.label}` : `Capture ${activeStep + 1} of 3`}
              </Text>
            </View>
          )}
        </View>

        {showTips && !isBusy && !isSuccess ? (
          <ScanTipsCard onDismiss={() => setShowTips(false)} />
        ) : null}
      </View>
    </View>
  );
}

const BRACKET_SIZE = 28;
const BRACKET_THICK = 3;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.cameraBackground },
  overlay: { flex: 1, backgroundColor: 'transparent' },
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
  permissionButtonText: { color: Colors.navy, fontSize: 15, fontWeight: '700' },
  skipButton: { marginTop: 16 },
  skipText: {
    color: Colors.cameraGuide,
    fontSize: 14,
    opacity: 0.7,
    textDecorationLine: 'underline',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 8,
  },
  screenLabel: { color: Colors.white, fontSize: 13, fontWeight: '600', opacity: 0.9 },
  headerActions: { flexDirection: 'row', gap: 8 },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  progressStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  progressStepCaptured: { borderColor: Colors.green },
  progressStepSelected: { borderColor: Colors.white, borderWidth: 2 },
  progressText: { color: Colors.white, fontSize: 11, fontWeight: '600' },
  guideArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  ovalGuideSuccess: { borderColor: Colors.green, borderWidth: 3 },
  bracket: { position: 'absolute', borderColor: Colors.cameraGuide },
  bracketTopLeft: {
    top: 0,
    left: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderTopWidth: BRACKET_THICK,
    borderLeftWidth: BRACKET_THICK,
  },
  bracketTopRight: {
    top: 0,
    right: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderTopWidth: BRACKET_THICK,
    borderRightWidth: BRACKET_THICK,
  },
  bracketBottomLeft: {
    bottom: 0,
    left: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderBottomWidth: BRACKET_THICK,
    borderLeftWidth: BRACKET_THICK,
  },
  bracketBottomRight: {
    bottom: 0,
    right: 0,
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    borderBottomWidth: BRACKET_THICK,
    borderRightWidth: BRACKET_THICK,
  },
  positionTitle: {
    color: Colors.white,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 18,
    textAlign: 'center',
  },
  statusText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '500',
    marginTop: 8,
    maxWidth: SCREEN_WIDTH * 0.82,
    textAlign: 'center',
    opacity: 0.9,
  },
  statusTextSuccess: { color: Colors.green, fontWeight: '700' },
  statusTextError: { color: '#FF8A8A' },
  bottomArea: {
    paddingBottom: 48,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 145,
  },
  processingContainer: { alignItems: 'center' },
  processingText: { color: Colors.white, fontSize: 14, marginTop: 12, opacity: 0.85 },
  successContainer: { alignItems: 'center' },
  successText: { color: Colors.white, fontSize: 13, marginTop: 10, opacity: 0.8 },
  captureSection: { alignItems: 'center' },
  captureButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.cameraButton,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  captureButtonInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.cameraButton,
    borderWidth: 2,
    borderColor: Colors.cameraButtonInner,
  },
  captureLabel: { color: Colors.white, fontSize: 13, fontWeight: '600', marginTop: 10 },
  reviewActions: { alignItems: 'center', width: '100%', paddingHorizontal: 32 },
  submitButton: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: Colors.green,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitButtonText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  startOverButton: { paddingVertical: 11, paddingHorizontal: 20 },
  startOverText: { color: Colors.white, fontSize: 13, textDecorationLine: 'underline' },
});
