import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Colors from '../constants/Colors';

interface ActivityItemProps {
  courseName: string;
  date: string;
  status: 'present' | 'late' | 'absent' | string;
}

export default function ActivityItem({ courseName, date, status }: ActivityItemProps) {
  const isPresent = status === 'present';
  const isLate = status === 'late';

  const pillColor = isPresent
    ? Colors.toggleActive
    : isLate
    ? Colors.late
    : Colors.toggleInactive;

  const pillLabel = isPresent ? '✓' : isLate ? 'L' : '✗';

  return (
    <View style={styles.container}>
      <View style={styles.info}>
        <Text style={styles.courseName} numberOfLines={1}>
          {courseName}
        </Text>
        <Text style={styles.date}>{date}</Text>
      </View>

      <View style={[styles.pill, { backgroundColor: pillColor }]}>
        <Text style={styles.pillText}>{pillLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
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
    color: Colors.textSecondary,
  },
  pill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
});
