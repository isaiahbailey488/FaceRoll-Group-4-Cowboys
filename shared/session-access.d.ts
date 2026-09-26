export function membershipId(courseId: string, uid: string): string;
export function activeCourseIds(enrollments: unknown[], uid: string): Set<string>;
export function accessibleActiveSessions(sessions: unknown[], enrollments: unknown[], uid: string, now?: number): unknown[];
