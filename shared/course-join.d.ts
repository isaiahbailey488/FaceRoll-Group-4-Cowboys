export type CoursePreview = { courseId: string; courseName: string; instructorName: string; alreadyJoined: boolean; status?: string };
export type JoinState = { stage: 'scanning' | 'resolving' | 'confirm' | 'joining' | 'success' | 'error'; course?: CoursePreview; message?: string };
export function parseInvitation(raw: string): string;
export function createJoinFlow(request: (action: 'resolve' | 'join', token: string) => Promise<CoursePreview>, onChange: (state: JoinState) => void): {
  reset(): void; cancel(): void; scan(raw: string): Promise<void>; join(): Promise<void>;
};
export function requestCourseInvitation(baseUrl: string, user: {getIdToken(): Promise<string>} | null, action: 'resolve' | 'join', token: string): Promise<CoursePreview>;
