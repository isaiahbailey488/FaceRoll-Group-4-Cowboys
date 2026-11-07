import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  Linking,
  LayoutAnimation,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/Colors';

type HelpItem = {
  question: string;
  answer: string;
};

type HelpSection = {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  items: HelpItem[];
};

const HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Checking In',
    icon: 'scan-outline',
    items: [
      {
        question: 'How do I join a course?',
        answer:
          'From Home, tap Join a Course and scan your instructor\'s invitation QR code. Check the course name, tap Confirm course, then Done. Joining does not start attendance: your instructor must start an active session before the course is available in Check-In.',
      },
      {
        question: 'How do I check in to class?',
        answer:
          'From Home, tap Check-In and select your course below your name. Your instructor must have an active session with a saved classroom zone. FaceRoll collects location automatically; allow foreground access and Precise Location when asked. With facial recognition off, tap Check In with Location. With it on, enroll first, allow camera access, read Before you scan, tap Got it, and take your photo. Your face must match before your classroom location is verified. Wait for Attendance Recorded! before leaving.',
      },
      {
        question: 'Why does FaceRoll ask for my location?',
        answer:
          'Both face and location-only check-in require classroom location verification. FaceRoll collects a temporary reading when you open an eligible active session and stops collecting after the reading is ready or the attempt ends. Getting a reading does not record attendance; tap Check In and wait for confirmation.',
      },
      {
        question: 'Do I need to refresh my location before each attempt?',
        answer:
          'No. There is no Get location or Refresh location step. FaceRoll reuses a still-fresh reading for quick photo retakes. If it expires, is rejected, or was cleared when you left the app, your next Check In attempt collects a replacement automatically. It does not keep refreshing while you wait.',
      },
      {
        question: 'What if location permission is denied or the signal is poor?',
        answer:
          'Use Open Settings when offered, or Open Device Settings below. Allow location while using the app, enable Precise Location, and check that Location Services are on. Choose Expo Go in phone settings when using Expo Go, or FaceRoll for an installed app. Return to Check-In and try again; returning from Settings alone does not start collection. If the signal is poor, try again from a spot inside the classroom with a clearer signal, or ask your instructor for help.',
      },
      {
        question: 'Why could my location not be verified while I am in class?',
        answer:
          'Indoor location readings can be imprecise. Being in the room does not guarantee that the phone can provide a reliable reading for the saved classroom zone. Try checking in again. If it still fails, ask your instructor to check the saved classroom pin or record your attendance manually. Location verification cannot reliably distinguish adjacent classrooms or floors.',
      },
      {
        question: 'Why does it say "No Active Session"?',
        answer:
          'There is no available active session for a course you have joined. It may not have started yet or may have ended. Confirm that you joined the right course, ask your instructor to start a session, then tap Retry.',
      },
      {
        question: 'Why was I marked Late instead of Present?',
        answer:
          'The server uses your instructor\'s session settings to decide Present or Late. Check-ins after the grace period are Late only when late check-ins are allowed and the check-in window is still open. Ask your instructor if the window has closed.',
      },
      {
        question: 'It says I\'m already checked in.',
        answer:
          'You can only check in once per session. Your existing check-in has already been recorded. Pull down on the Home screen to refresh your Recent Activity.',
      },
      {
        question: 'What if I lose connection or close the app while it is verifying?',
        answer:
          'Check Recent Activity on Home before trying again. A request already sent may finish even after you leave the screen. If attendance was accepted, retrying keeps the original record. If there is no confirmed record, reopen Check-In and try again while the session is still open, or ask your instructor for help.',
      },
      {
        question: 'How do I correct missing or incorrect attendance?',
        answer:
          'Contact your instructor and explain what happened. They can review and correct your attendance manually, including when face or location verification fails. Pull down on Home to refresh Recent Activity after a correction.',
      },
    ],
  },
  {
    title: 'Face Enrollment & Camera',
    icon: 'camera-outline',
    items: [
      {
        question: 'How do I enroll my face?',
        answer:
          'In Profile & Settings, make sure Opt Out of Facial Recognition is off, then tap Enroll Face. Allow camera access, read Before you scan, and tap Got it. Capture three positions: Forward, Slightly Left, and Slightly Right. Tap a captured position to retake it if needed, then tap Submit Three Photos and wait for success. The camera stops after the third capture while you review. Enrollment is required for face check-in; location-only check-in does not require it.',
      },
      {
        question: 'My face isn\'t being recognized.',
        answer:
          'Keep your full face inside the oval, face a light, and avoid a bright window behind you. Remove hats, hoods, sunglasses, and masks. Wear ordinary glasses consistently with enrollment and reduce glare. During Check-In, the camera stays open after a retryable face error so you can retake the photo. Location is replaced automatically only when needed. If repeated attempts fail, ask your instructor for a manual correction or use Re-enroll Face in Profile & Settings.',
      },
      {
        question: 'Does the oval crop my photo?',
        answer:
          'The oval is a positioning guide; the full camera photo is used. Keep your entire face inside the oval and make sure no other faces, including faces in pictures or posters, appear anywhere in the camera view. The guide stays in the same place during capture and retakes.',
      },
      {
        question: 'Why is the camera off after I return to the app?',
        answer:
          'The camera stops when you leave the capture screen or put FaceRoll in the background. Tap Resume Camera, wait for the preview, then tap the capture button to take a new photo. Check-In collects a replacement location automatically if needed. During enrollment, review after the third photo keeps the camera off; selecting a position to retake opens it again.',
      },
      {
        question: 'It says "Recognition Unavailable."',
        answer:
          'FaceRoll could not reach the recognition service. Check your network connection and try again in a moment. If it keeps happening, let your instructor know so they can record your attendance manually.',
      },
      {
        question: 'The camera isn\'t working.',
        answer:
          'Camera access is needed for face enrollment, face check-in, and scanning course invitation QR codes. Location-only check-in does not use the camera. Allow access when asked, or open device settings if it was denied. Enable camera access for Expo Go when using Expo Go, or FaceRoll for an installed app. Return to the capture screen; if permission still appears off, close and reopen that screen. Tap Resume Camera if shown.',
      },
    ],
  },
  {
    title: 'Privacy & Account',
    icon: 'shield-checkmark-outline',
    items: [
      {
        question: 'Can I opt out of facial recognition?',
        answer:
          'Yes. In Profile & Settings, turn on "Opt Out of Facial Recognition." This disables facial recognition and requests permanent deletion of saved embeddings. You can check in using classroom location only, without a photo or face enrollment, even while deletion is pending. With facial recognition on, check-in requires face enrollment, a face scan and location. Both options require an enabled classroom zone.',
      },
      {
        question: 'Can I turn facial recognition back on later?',
        answer:
          'Yes. Wait for facial data deletion to finish, then turn off Opt Out of Facial Recognition in Profile & Settings and enroll your face again. Your old enrollment is not restored. Location-only check-in remains available while deletion is pending. If deletion needs another attempt, use Retry Facial Data Deletion in Profile & Settings.',
      },
      {
        question: 'Does FaceRoll save or track my location?',
        answer:
          'Opening an eligible active Check-In automatically collects a temporary location reading. Collection stops once a reading is ready, on cancellation, or after a timeout; it does not continue while you wait or in the background. A still-fresh reading may be reused for a photo retake, but expires without continuous refresh. Readings are cleared when you leave or background the screen, change courses or accounts, or complete check-in. Precise coordinates are processed temporarily over HTTPS and are not saved in attendance history; attendance records store the verification result.',
      },
      {
        question: 'What facial data is saved?',
        answer:
          'Enrollment saves an encrypted numerical face template called an embedding. Check-in photos are used temporarily for verification and are not saved in your attendance history. Photos and location readings are sent over encrypted HTTPS connections. Turning on Opt Out of Facial Recognition requests deletion of the saved face template and disables facial recognition while deletion is pending.',
      },
      {
        question: 'How do I change my password?',
        answer:
          'Go to Profile & Settings and tap Change Password to request a reset link. When email delivery is available, follow the link and check your spam folder if needed. Reset emails are not delivered in the local demo; ask your instructor for account help during the demonstration.',
      },
      {
        question: 'Who can see my attendance?',
        answer:
          'Your attendance records are shared with your instructor through the FaceRoll instructor dashboard. You can see your own recent records on the Home screen.',
      },
    ],
  },
];

export default function HelpScreen() {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggleItem = (key: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => (prev === key ? null : key));
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleRow}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
            activeOpacity={0.8}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.navy} />
          </TouchableOpacity>
          <Text style={styles.pageTitle}>Help & FAQ</Text>
        </View>

        {HELP_SECTIONS.map((section) => (
          <View key={section.title} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons
                name={section.icon}
                size={16}
                color={Colors.green}
                style={styles.sectionIcon}
              />
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>

            {section.items.map((item, index) => {
              const key = `${section.title}-${index}`;
              const isOpen = expanded === key;
              const isLast = index === section.items.length - 1;

              return (
                <View key={key} style={[styles.item, isLast && styles.itemLast]}>
                  <TouchableOpacity
                    style={styles.questionRow}
                    onPress={() => toggleItem(key)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.questionText}>{item.question}</Text>
                    <Ionicons
                      name={isOpen ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color={Colors.inputPlaceholder}
                    />
                  </TouchableOpacity>
                  {isOpen ? <Text style={styles.answerText}>{item.answer}</Text> : null}
                </View>
              );
            })}
          </View>
        ))}

        <View style={styles.contactCard}>
          <Ionicons name="chatbubbles-outline" size={28} color={Colors.navy} />
          <Text style={styles.contactTitle}>Still need help?</Text>
          <Text style={styles.contactText}>
            Contact your instructor if your attendance looks wrong or you can't check in. They
            can mark your attendance manually.
          </Text>
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => Linking.openSettings()}
            activeOpacity={0.85}
          >
            <Ionicons name="settings-outline" size={18} color={Colors.white} style={{ marginRight: 8 }} />
            <Text style={styles.settingsButtonText}>Open Device Settings</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.versionText}>FaceRoll v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.offWhite,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  backButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.green,
    letterSpacing: -0.5,
  },

  section: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    marginBottom: 4,
  },
  sectionIcon: {
    marginRight: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.green,
  },
  item: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  itemLast: {
    borderBottomWidth: 0,
  },
  questionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  questionText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: Colors.textPrimary,
    marginRight: 12,
  },
  answerText: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
    paddingBottom: 14,
  },

  contactCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  contactTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.green,
    marginTop: 8,
    marginBottom: 6,
  },
  contactText: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 16,
  },
  settingsButton: {
    backgroundColor: Colors.navy,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  settingsButtonText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '600',
  },

  versionText: {
    textAlign: 'center',
    fontSize: 12,
    color: Colors.inputPlaceholder,
    marginTop: 8,
  },
});
