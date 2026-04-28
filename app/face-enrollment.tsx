import React, { useState, useRef, useEffect } from 'react';
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
import { enrollFace } from '../services/attendance';
import { getCurrentUser, markFaceEnrolled } from '../services/auth';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const OVAL_WIDTH = SCREEN_WIDTH * 0.55;
const OVAL_HEIGHT = OVAL_WIDTH * 1.3;

type EnrollmentState = 'idle' | 'capturing' | 'processing' | 'success' | 'error';

export default function FaceEnrollmentScreen() {
  const router = useRouter();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [enrollState, setEnrollState] = useState<EnrollmentState>('idle');
  const [statusMessage, setStatusMessage] = useState('Position your face within the oval');

  useEffect(() => {
    if (permission && !permission.granted) {
      requestPermission();
    }
  }, [permission]);

  useEffect(() => {
    switch (enrollState) {
      case 'idle':
        setStatusMessage('Position your face within the oval');
        break;
      case 'capturing':
        setStatusMessage('Hold still...');
        break;
      case 'processing':
        setStatusMessage('Enrolling your face...');
        break;
      case 'success':
        setStatusMessage('Face enrolled successfully!');
        break;
      case 'error':
        setStatusMessage('Enrollment failed. Please try again.');
        break;
    }
  }, [enrollState]);

  const handleCapture = async () => {
    if (enrollState !== 'idle' && enrollState !== 'error') return;
    if (!cameraRef.current) return;

    const user = getCurrentUser();
    if (!user) {
      Alert.alert('Error', 'You must be logged in to enroll your face.');
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
        throw new Error('Failed to capture image.');
      }

      setEnrollState('processing');

      const result = await enrollFace(user.uid, photo.base64);

      if (result.success) {
        await markFaceEnrolled(user.uid, true);
        setEnrollState('success');

        setTimeout(() => {
          router.replace('/(tabs)/home');
        }, 1800);
      } else {
        throw new Error(result.message || 'Enrollment failed.');
      }
    } catch (error: any) {
      if (__DEV__) {
        console.warn('Enrollment error:', error?.code || error?.message || error);
      }
      setEnrollState('error');

      if (error?.code === 'firestore/rules-not-deployed') {
        Alert.alert(
          'Firestore Rules Not Deployed',
          'Your face image was processed, but the enrollment flag could not be saved to Firestore because security rules are blocking writes. Deploy firestore.rules (see FIRESTORE_SETUP.md) and try again.'
        );
      } else if (
        error?.code === 'permission-denied' ||
        /insufficient permissions/i.test(String(error?.message))
      ) {
        Alert.alert(
          'Permission Denied',
          'Firestore is blocking this write. Deploy firestore.rules to your Firebase project (see FIRESTORE_SETUP.md).'
        );
      } else if (error?.message) {
        Alert.alert('Enrollment Failed', error.message);
      }
    }
  };

  const handleClose = () => {
    if (enrollState === 'processing') return;
    Alert.alert(
      'Skip Enrollment?',
      'You can enroll your face later from your Profile. Without enrollment, you won\'t be able to check in via facial recognition.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Skip for Now',
          onPress: () => router.replace('/(tabs)/home'),
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
        <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} style={{ marginTop: 16 }}>
          <Text style={styles.skipText}>Skip for Now</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const isProcessing = enrollState === 'capturing' || enrollState === 'processing';
  const isSuccess = enrollState === 'success';

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
          <Text style={styles.screenLabel}>Face Capture — Enrollment</Text>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={handleClose}
            disabled={isProcessing}
          >
            <Ionicons name="close" size={22} color={Colors.white} />
          </TouchableOpacity>
        </SafeAreaView>

        <View style={styles.guideArea}>
          <View style={styles.bracketsContainer}>
            <View style={[styles.bracket, styles.bracketTopLeft]} />
            <View style={[styles.bracket, styles.bracketTopRight]} />
            <View style={[styles.bracket, styles.bracketBottomLeft]} />
            <View style={[styles.bracket, styles.bracketBottomRight]} />

            <View
              style={[
                styles.ovalGuide,
                isSuccess && styles.ovalGuideSuccess,
              ]}
            />
          </View>

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
          {isProcessing ? (
            <View style={styles.processingContainer}>
              <ActivityIndicator size="large" color={Colors.white} />
              <Text style={styles.processingText}>
                {enrollState === 'capturing' ? 'Capturing...' : 'Processing...'}
              </Text>
            </View>
          ) : isSuccess ? (
            <View style={styles.successContainer}>
              <Ionicons name="checkmark-circle" size={64} color={Colors.green} />
              <Text style={styles.successText}>Redirecting to Home...</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[
                styles.captureButton,
                enrollState === 'error' && styles.captureButtonRetry,
              ]}
              onPress={handleCapture}
              activeOpacity={0.8}
            >
              <View style={styles.captureButtonInner} />
            </TouchableOpacity>
          )}
        </View>
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
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 8,
  },
  screenLabel: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: '500',
    opacity: 0.85,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
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

  bracket: {
    position: 'absolute',
    borderColor: Colors.cameraGuide,
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
  },
  statusTextSuccess: {
    color: Colors.green,
    fontWeight: '700',
  },
  statusTextError: {
    color: '#FF6B6B',
  },

  bottomArea: {
    paddingBottom: 60,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
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
    color: Colors.white,
    fontSize: 13,
    marginTop: 10,
    opacity: 0.7,
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
});
