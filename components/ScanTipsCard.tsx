import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/Colors';
import { SCAN_TIPS, SCAN_TIPS_TITLE } from '../constants/ScanTips';

interface ScanTipsCardProps {
  onDismiss: () => void;
}

// Rendered over the capture controls (never the camera oval) until dismissed.
export default function ScanTipsCard({ onDismiss }: ScanTipsCardProps) {
  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.headerRow}>
        <Ionicons name="bulb-outline" size={16} color={Colors.navy} style={styles.headerIcon} />
        <Text style={styles.title}>{SCAN_TIPS_TITLE}</Text>
        <TouchableOpacity
          onPress={onDismiss}
          style={styles.dismissButton}
          accessibilityRole="button"
          accessibilityLabel="Dismiss tips"
          hitSlop={8}
        >
          <Text style={styles.dismissText}>Got it</Text>
        </TouchableOpacity>
      </View>
      {SCAN_TIPS.map((tip) => (
        <View key={tip} style={styles.tipRow}>
          <Ionicons name="checkmark" size={14} color={Colors.green} style={styles.tipIcon} />
          <Text style={styles.tipText}>{tip}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 32,
    backgroundColor: Colors.white,
    borderRadius: 14,
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
    color: Colors.textPrimary,
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
