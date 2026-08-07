/**
 * Public surface of the lists layer. Import from here, never the inner
 * modules — same rule every other `lib/` package in this app follows.
 *
 * `queries.ts` is deliberately NOT re-exported here — it is `server-only` and
 * this barrel has no such guard, so re-exporting it would let a Client
 * Component import server-only code through an innocuous-looking path.
 * Server Components needing it import `@/lib/lists/queries` directly; Client
 * Components go through the Server Actions in `actions.ts` instead.
 */
export {
  acceptInviteAction,
  addListItemAction,
  createListAction,
  deleteListAction,
  fetchAgreementAction,
  fetchListDetailAction,
  followListAction,
  inviteCollaboratorAction,
  removeCollaboratorAction,
  removeListItemAction,
  unfollowListAction,
  updateListAction,
  type ListActionResult,
} from "./actions";

export { ListError, SAFE_LIST_MESSAGE, listErrorMessage } from "./errors";
export type { ListErrorKind } from "./errors";

export type {
  CollaboratorStatus,
  ListCollaborator,
  ListDetail,
  ListItemEntry,
  ListMember,
  ListSummary,
  ListVisibility,
  MemberStatus,
  PendingInvite,
} from "./types";

export {
  LIST_NAME_REJECTION_MESSAGE,
  MAX_LIST_DESCRIPTION_LENGTH,
  MAX_LIST_NAME_LENGTH,
  isListVisibility,
  validateListDescription,
  validateListName,
} from "./validate";
export type {
  ListDescriptionValidation,
  ListNameRejection,
  ListNameValidation,
} from "./validate";

export { computeAgreementItems } from "./wire";
