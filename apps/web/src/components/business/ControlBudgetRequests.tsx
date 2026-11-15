import type { ControlBudgetRequest, ControlBudgetRequestLevel } from "@codenine/contracts/control";
import React from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { type ControlCall, SectionTitle } from "./adminParts";

const LEVELS: Record<ControlBudgetRequestLevel, string> = {
  "person-month": "their budget this month",
  "person-day": "their budget today",
  "department-month": "the department's budget this month",
};

const dollars = (usd: number) =>
  usd.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Requests for more AI budget the signed-in person may decide, and those decided lately. */
export function BudgetRequestsSection({
  requests,
  onAction,
}: {
  readonly requests: ReadonlyArray<ControlBudgetRequest>;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  const decide = (request: ControlBudgetRequest, approve: boolean) =>
    void onAction((client) =>
      client.admin.decideBudgetRequest({ params: { requestId: request.id }, payload: { approve } }),
    );
  return (
    <section>
      <SectionTitle>Requests for more AI budget</SectionTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        An approved amount adds to that budget for the month or day it was asked in.
      </p>
      {requests.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No requests.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border/70">
          {requests.map((request) => (
            <li className="space-y-1 py-2 text-sm" key={request.id}>
              <p>
                <span className="font-medium">{request.personName}</span>
                {request.departmentName === null ? "" : ` in ${request.departmentName}`} asks for{" "}
                {dollars(request.amountUsd)} more of {LEVELS[request.level]}.{" "}
                {request.status === "pending" ? null : (
                  <Badge variant={request.status === "approved" ? "success" : "secondary"}>
                    {request.status === "approved" ? "Approved" : "Declined"}
                  </Badge>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                “{request.reason}” · {dollars(request.use.spentUsd)} spent
                {request.use.limitUsd === null ? "" : ` of ${dollars(request.use.limitUsd)}`}
                {request.decidedBy === null ? "" : ` · decided by ${request.decidedBy}`}
              </p>
              {request.status === "pending" ? (
                <div className="flex gap-2">
                  <Button onClick={() => decide(request, true)} size="xs">
                    Approve
                  </Button>
                  <Button onClick={() => decide(request, false)} size="xs" variant="outline">
                    Decline
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
