import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import Colors from '../constants/Colors';

interface FaceRollLogoProps {
  size?: number;
  showText?: boolean;
  textColor?: string;
}

export default function FaceRollLogo({
  size = 80,
  showText = true,
  textColor = Colors.navy,
}: FaceRollLogoProps) {
  return (
    <View style={styles.container}>
      <Image
        source={require('../assets/faceroll-logo.png')}
        style={{ width: size, height: size }}
        resizeMode="contain"
      />

      {showText && (
        <Text style={[styles.logoText, { color: textColor }]}>FaceRoll</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  logoText: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 6,
    color: Colors.navy,
  },
});
