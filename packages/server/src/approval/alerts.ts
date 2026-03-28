export interface ApprovalAlertRecord {
  alertType: string;
  ownerKey: string;
  requestId?: string | null;
  actionId?: string | null;
  candidateId?: string | null;
  assetId?: string | null;
  gateway?: string | null;
  actionType?: string | null;
  routeOrModule?: string | null;
  attemptedAction?: string | null;
  reason?: string;
}

export interface ApprovalEventLike {
  event: string;
  ownerKey: string;
  requestId?: string | null;
  actionId?: string | null;
  candidateId?: string | null;
  assetId?: string | null;
  gateway?: string | null;
  actionType?: string | null;
  routeOrModule?: string | null;
  attemptedAction?: string | null;
}

export function buildApprovalAlert(event: ApprovalEventLike): ApprovalAlertRecord | null {
  if (event.event === "approval_tx_failed") {
    return {
      alertType: "approval_tx_failed",
      ownerKey: event.ownerKey,
      requestId: event.requestId ?? null,
      actionId: event.actionId ?? null,
      candidateId: event.candidateId ?? null,
      assetId: event.assetId ?? null,
      gateway: event.gateway ?? null,
      actionType: event.actionType ?? null,
      reason: "approval transaction failed",
    };
  }

  if (event.event === "direct_write_blocked") {
    return {
      alertType: "direct_write_blocked",
      ownerKey: event.ownerKey,
      requestId: event.requestId ?? null,
      actionId: event.actionId ?? null,
      candidateId: event.candidateId ?? null,
      assetId: event.assetId ?? null,
      gateway: event.gateway ?? null,
      actionType: event.actionType ?? null,
      routeOrModule: event.routeOrModule ?? null,
      attemptedAction: event.attemptedAction ?? null,
      reason: "direct formal write attempt blocked",
    };
  }

  if (event.event === "formal_asset_written") {
    const invalidActionType = event.actionType === "other";
    const invalidGateway = event.gateway !== "controlled_write_service";

    if (invalidActionType || invalidGateway) {
      return {
        alertType: "formal_asset_written_invalid",
        ownerKey: event.ownerKey,
        requestId: event.requestId ?? null,
        actionId: event.actionId ?? null,
        candidateId: event.candidateId ?? null,
        assetId: event.assetId ?? null,
        gateway: event.gateway ?? null,
        actionType: event.actionType ?? null,
        reason: invalidActionType
          ? "unexpected formal asset action type"
          : "unexpected formal asset gateway metadata",
      };
    }
  }

  return null;
}
