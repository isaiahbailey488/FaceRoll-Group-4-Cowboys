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
          'From the Home screen, tap Join a Course and scan the QR code your instructor shows. Confirm the course name, then tap Confirm course. Your courses will then appear when you check in.',
      },
      {
        question: 'How do I check in to class?',
        answer:
          'From the Home screen, tap Check-In. Select your course, center your face inside the guide, and tap the capture button. You\'ll see "Attendance Recorded!" when it succeeds.',
      },
      {
        question: 'Why does it say "No Active Session"?',
        answer:
          'Your instructor hasn\'t started an attendance session for your course yet. Wait for them to start it, then tap Retry.',
      },
      {
        question: 'Why was I marked Late instead of Present?',
        answer:
          'You\'re marked Present if you check in within the grace period after the session starts (10 minutes unless your instructor sets a different time). Check-ins after that are marked Late.',
      },
      {
        question: 'It says I\'m already checked in.',
        answer:
          'You can only check in once per session. Your existing check-in has already been recorded. Pull down on the Home screen to refresh your Recent Activity.',
      },
    ],
  },
  {
    title: 'Face Enrollment',
    icon: 'camera-outline',
    items: [
      {
        question: 'How do I enroll my face?',
        answer:
          'Go to Profile & Settings and tap Enroll Face. Follow the on-screen guide to capture your face. You must be enrolled before you can check in with facial recognition.',
      },
      {
        question: 'My face isn\'t being recognized.',
        answer:
          'Make sure you\'re in good lighting, facing the camera directly, and not wearing sunglasses, a hat, or a mask. If it still fails, re-enroll from Profile & Settings. Re-enrolling replaces your old facial data.',
      },
      {
        question: 'It says "Recognition Unavailable."',
        answer:
          'The FaceRoll recognition service couldn\'t be reached. Check your internet connection and try again in a moment. If it keeps happening, let your instructor know so they can mark your attendance.',
      },
      {
        question: 'The camera isn\'t working.',
        answer:
          'FaceRoll needs camera access to enroll and check in. If you denied access earlier, turn it back on in your device settings.',
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
          'Yes. In Profile & Settings, turn on "Opt Out of Facial Recognition." Your instructor will then mark your attendance manually, and you won\'t be able to check in through the app.',
      },
      {
        question: 'How do I change my password?',
        answer:
          'Go to Profile & Settings and tap Change Password. We\'ll email you a reset link. Check your spam folder if it doesn\'t arrive within a few minutes.',
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
                color={Colors.textSecondary}
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
  },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },

  section: {
    backgroundColor: Colors.white,
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
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
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
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
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  contactTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.textPrimary,
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
