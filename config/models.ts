// The only file that names a model. Lessons import from here, so a model change is one edit.
export const MODELS = {
  default: process.env.MODEL ?? "set-me-in-the-course-repo",
} as const;
