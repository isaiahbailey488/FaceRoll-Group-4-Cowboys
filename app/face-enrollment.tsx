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
import { getCurrentUser, markFaceEnrolled } from '../services/auth';
import {
  discardTemporaryCameraFile,
  enrollFace,
  RecognitionApiError,
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
  const cameraRef = useRef<CameraView>(null);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [enrollState, setEnrollState] = useState<EnrollmentState>('idle');
  const [capturedImages, setCapturedImages] = useState<Array<string | null>>(
    emptyCaptures
  );
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    if (permission && !permission.granted) {
      requestPermission();
    }
  }, [permission, requestPermission]);

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
        return 'Enrollment failed. Retake a position or try submitting again.';
      default:
        return currentStep.instruction;
    }
  })();

  const clearCaptures = () => {
    setCapturedImages(emptyCaptures());
    setActiveStep(0);
  };

  const handleCapture = async () => {
    if (enrollState !== 'idle' || !cameraRef.current) return;
    if (!getCurrentUser()) {
      Alert.alert('Sign In Required', 'You must be logged in to enroll your face.');
      return;
    }

    try {
      setEnrollState('capturing');
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.8,
        skipProcessing: false,
      });
      if (!photo?.base64) {
        discardTemporaryCameraFile(photo?.uri);
        throw new Error('Failed to capture image.');
      }

      const updated = [...capturedImages];
      updated[activeStep] = photo.base64;
      discardTemporaryCameraFile(photo.uri);
      setCapturedImages(updated);

      const nextMissing = updated.findIndex((image) => !image);
      if (nextMissing >= 0) {
        setActiveStep(nextMissing);
        setEnrollState('idle');
      } else {
        setEnrollState('review');
      }
    } catch (error: any) {
      if (__DEV__) console.warn('Capture error:', error?.message || error);
      setEnrollState('idle');
      Alert.alert('Capture Failed', error?.message || 'Please try taking the photo again.');
    }
  };

  const handleRetake = (index: number) => {
    if (isBusy || isSuccess) return;
    setActiveStep(index);
    setEnrollState('idle');
  };

  const handleStartOver = () => {
    if (isBusy) return;
    clearCaptures();
    setEnrollState('idle');
  };

  const handleSubmit = async () => {
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
    try {
      setEnrollState('processing');
      const result = await enrollFace(images);
      if (result.sampleCount !== 3 || result.model !== 'Facenet512') {
        throw new RecognitionApiError(
          'invalid_enrollment_response',
          'The recognition server did not confirm three Facenet512 samples.'
        );
      }

      await markFaceEnrolled(user.uid, true);
      clearCaptures();
      setEnrollState('success');
      redirectTimer.current = setTimeout(() => {
        router.replace('/(tabs)/home');
      }, 1800);
    } catch (error: any) {
      if (__DEV__) {
        console.warn('Enrollment error:', error?.code || error?.message || error);
      }
      setEnrollState('error');

      if (error?.code === 'firestore/rules-not-deployed') {
        Alert.alert(
          'Enrollment Saved, Profile Update Failed',
          'Your embeddings were saved locally, but Firestore blocked the non-biometric enrollment-status update. Deploy the project Firestore rules before trying again.'
        );
      } else {
        Alert.alert(
          'Enrollment Failed',
          error?.message || 'Retake any unclear position and try again.'
        );
      }
    }
  };

  const handleClose = () => {
    if (isBusy) return;
    Alert.alert(
      'Leave Enrollment?',
      'Your unsent captures will be discarded. You can enroll later from your Profile.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => {
            clearCaptures();
            router.replace('/(tabs)/home');
          },
        },
      ]
    );
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
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={'front' as CameraType}
      />

      <View style={styles.overlay}>
        <SafeAreaView style={styles.header}>
          <Text style={styles.screenLabel}>Private Face Enrollment</Text>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={handleClose}
            disabled={isBusy}
          >
            <Ionicons name="close" size={22} color={Colors.white} />
          </TouchableOpacity>
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
            {isReview ? `${capturedCount} of 3 captured` : currentStep.label}
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
              >
                <View style={styles.captureButtonInner} />
              </TouchableOpacity>
              <Text style={styles.captureLabel}>
                {capturedImages[activeStep] ? `Retake ${currentStep.label}` : `Capture ${activeStep + 1} of 3`}
              </Text>
            </View>
          )}
        </View>
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
