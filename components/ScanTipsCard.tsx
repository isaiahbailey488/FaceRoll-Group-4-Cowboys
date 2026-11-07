import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/Colors';
import { SCAN_TIPS, SCAN_TIPS_TITLE } from '../constants/ScanTips';

interface ScanTipsCardProps {
  onDismiss: () => void;
  inline?: boolean;
  modal?: boolean;
}

// Camera screens use a blocking, scrollable modal so students acknowledge the tips before capture.
export default function ScanTipsCard({ onDismiss, inline = false, modal = false }: ScanTipsCardProps) {
  const body = <>
      <View style={styles.headerRow}>
        <Ionicons name="bulb-outline" size={16} color={Colors.navy} style={styles.headerIcon} />
        <Text style={styles.title}>{SCAN_TIPS_TITLE}</Text>
        {!modal && <TouchableOpacity
          onPress={onDismiss}
          style={styles.dismissButton}
          accessibilityRole="button"
          accessibilityLabel="Dismiss tips"
          hitSlop={8}
        >
          <Text style={styles.dismissText}>Got it</Text>
        </TouchableOpacity>}
      </View>
      {SCAN_TIPS.map((tip) => (
        <View key={tip} style={styles.tipRow}>
          <Ionicons name="checkmark" size={14} color={Colors.green} style={styles.tipIcon} />
          <Text style={styles.tipText}>{tip}</Text>
        </View>
      ))}
      {modal && <TouchableOpacity style={styles.continueButton} onPress={onDismiss}
        accessibilityRole="button" accessibilityLabel="Dismiss tips">
        <Text style={styles.dismissText}>Got it</Text>
      </TouchableOpacity>}
  </>;
  const card = <View style={[styles.card, inline && styles.inlineCard, modal && styles.modalCard]}
    accessibilityRole="summary" accessibilityViewIsModal={modal}>
    {modal ? <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent}>{body}</ScrollView> : body}
  </View>;
  return modal ? <Modal visible transparent animationType="fade" presentationStyle="overFullScreen"
    onRequestClose={onDismiss} statusBarTranslucent>
    <View style={styles.backdrop}>{card}</View>
  </Modal> : card;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', padding: 24 },
  modalCard: { position: 'relative', left: 0, right: 0, bottom: 0, width: '100%', maxWidth: 440,
    maxHeight: '85%', alignSelf: 'center', padding: 18 },
  modalScroll: { flexGrow: 0 },
  modalContent: { paddingVertical: 4 },
  continueButton: { backgroundColor: Colors.navy, borderRadius: 10, minHeight: 48,
    alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  inlineCard: { position: 'relative', left: 0, right: 0, bottom: 0, marginHorizontal: 16, marginVertical: 12 },
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 32,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingVertical: 12,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  headerIcon: {
    marginRight: 6,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: Colors.green,
  },
  dismissButton: {
    backgroundColor: Colors.navy,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  dismissText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 2,
  },
  tipIcon: {
    marginRight: 6,
    marginTop: 2,
  },
  tipText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.textSecondary,
  },
});
