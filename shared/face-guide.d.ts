export interface FaceGuideFrame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export function faceGuideFrame(width: number, height: number): FaceGuideFrame;
