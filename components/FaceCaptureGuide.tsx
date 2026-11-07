import React, { useCallback, useState } from 'react';
import { Dimensions, LayoutChangeEvent, ScrollView, StyleSheet, View } from 'react-native';
import Colors from '../constants/Colors';
import { faceGuideFrame, FaceGuideFrame } from '../shared/face-guide';

export function useFaceGuideLayout() {
  const [viewport, setViewport] = useState(() => Dimensions.get('window'));
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setViewport(previous => previous.width === width && previous.height === height
        ? previous : { ...previous, width, height });
    }
  }, []);
  return { frame: faceGuideFrame(viewport.width, viewport.height), onLayout };
}

export default function FaceCaptureGuide({ frame, success = false, error = false }: {
  frame: FaceGuideFrame; success?: boolean; error?: boolean;
}) {
  return <View testID="face-capture-guide" pointerEvents="none" style={[styles.frame, frame]}>
    <View style={[StyleSheet.absoluteFill, styles.ovalGuide, { borderRadius: frame.width / 2 },
      success && styles.ovalGuideSuccess, error && styles.ovalGuideError]} />
    <View style={[styles.bracket, styles.topLeft]} />
    <View style={[styles.bracket, styles.topRight]} />
    <View style={[styles.bracket, styles.bottomLeft]} />
    <View style={[styles.bracket, styles.bottomRight]} />
  </View>;
}

/** A fixed viewport below the guide; content growth only increases scrolling. */
export function FaceCaptureControls({ frame, scrollRef, children }: {
  frame?: FaceGuideFrame;
  scrollRef?: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
  children: React.ReactNode;
}) {
  return <ScrollView ref={scrollRef} testID="face-capture-controls"
    style={[styles.controls, { top: frame ? frame.top + frame.height + 28 : 112 }]}
    contentContainerStyle={styles.controlsContent} showsVerticalScrollIndicator
    keyboardShouldPersistTaps="handled">
    {children}
  </ScrollView>;
}

const styles = StyleSheet.create({
  frame: { position: 'absolute' },
  ovalGuide: { borderWidth: 2, borderColor: Colors.cameraGuide, backgroundColor: 'transparent' },
  ovalGuideSuccess: { borderColor: Colors.cameraSuccess, borderWidth: 3 },
  ovalGuideError: { borderColor: Colors.cameraError },
  bracket: { position: 'absolute', width: 28, height: 28, borderColor: Colors.cameraGuide },
  topLeft: { top: -20, left: -20, borderTopWidth: 3, borderLeftWidth: 3 },
  topRight: { top: -20, right: -20, borderTopWidth: 3, borderRightWidth: 3 },
  bottomLeft: { bottom: -20, left: -20, borderBottomWidth: 3, borderLeftWidth: 3 },
  bottomRight: { bottom: -20, right: -20, borderBottomWidth: 3, borderRightWidth: 3 },
  controls: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  controlsContent: { paddingTop: 4, paddingBottom: 32, flexGrow: 1 },
});
