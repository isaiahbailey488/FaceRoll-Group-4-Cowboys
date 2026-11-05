import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Colors, { HomeColors } from '../constants/Colors';

interface ActivityItemProps {
  courseName: string;
  date: string;
  status: 'present' | 'late' | 'absent' | string;
}

export default function ActivityItem({ courseName, date, status }: ActivityItemProps) {
  const isPresent = status === 'present';
  const isLate = status === 'late';

  const isAbsent = status === 'absent';
  const pillColor = isPresent
    ? HomeColors.green
    : isLate
    ? HomeColors.late
    : isAbsent
    ? HomeColors.absent
    : HomeColors.muted;
  const pillBackground = isPresent
    ? HomeColors.presentBackground
    : isLate
    ? HomeColors.lateBackground
    : isAbsent
    ? HomeColors.absentBackground
    : HomeColors.background;

  const pillLabel = isPresent ? '✓' : isLate ? 'L' : isAbsent ? '✗' : '?';
  const statusLabel = isPresent ? 'Present' : isLate ? 'Late' : isAbsent ? 'Absent' : status;

  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={`${courseName}, ${date}, ${statusLabel}`}
    >
      <View style={styles.info}>
        <Text style={styles.courseName} numberOfLines={1}>
          {courseName}
        </Text>
        <Text style={styles.date}>{date}</Text>
      </View>

      <View style={[styles.pill, { backgroundColor: pillBackground, borderColor: pillColor }]}>
        <Text style={[styles.pillText, { color: pillColor }]}>{pillLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: HomeColors.background,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: HomeColors.border,
  },
  info: {
    flex: 1,
    marginRight: 12,
  },
  courseName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: 3,
  },
  date: {
    fontSize: 12,
    color: HomeColors.muted,
  },
  pill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
