/**
 * Public surface of the comments layer. Import from here, never the inner
 * modules — same rule every other `lib/` package in this app follows.
 *
 * `queries.ts` is deliberately NOT re-exported here: it is `server-only` and
 * this barrel has no such guard, so re-exporting it would let a Client
 * Component import server-only code through an innocuous-looking path. Server
 * Components needing it import `@/lib/comments/queries` directly; Client
 * Components go through the Server Actions in `actions.ts` instead.
 */
export {
  deleteCommentAction,
  editCommentAction,
  fetchCommentThreadAction,
  postCommentAction,
  reportCommentAction,
  toggleLikeAction,
  type CommentActionResult,
  type LikeResult,
} from "./actions";

export { CommentError, SAFE_COMMENT_MESSAGE, commentErrorMessage } from "./errors";
export type { CommentErrorKind } from "./errors";

export {
  episodeScope,
  isEpisodeScope,
  isGatedScope,
  titleScope,
  REPORT_REASONS,
} from "./types";
export type {
  Comment,
  CommentAuthor,
  CommentScope,
  CommentSectionData,
  CommentThread,
  ReportReason,
} from "./types";

export {
  COMMENT_BODY_REJECTION_MESSAGE,
  MAX_COMMENT_LENGTH,
  MAX_REPORT_NOTE_LENGTH,
  MIN_COMMENT_LENGTH,
  isReportReason,
  sanitizeCommentBody,
  validateCommentBody,
  validateReportNote,
} from "./validate";
export type {
  CommentBodyRejection,
  CommentBodyValidation,
  ReportNoteValidation,
} from "./validate";
