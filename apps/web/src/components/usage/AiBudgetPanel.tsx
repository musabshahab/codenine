import type {
  ControlBudgetRequestLevel,
  ControlBudgetUse,
  ControlMyUsage,
} from "@codenine/contracts/control";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";

import { callControl, controlErrorMessage } from "../../business/control";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const BUDGET_NAMES: Record<ControlBudgetUse["level"], string> = {
  "person-month": "Your budget this month",
  "person-day": "Your budget today",
  "department-month": "Your department this month",
  "company-month": "Your company this month",
};

const ASKABLE: Record<ControlBudgetRequestLevel, string> = {
  "person-month": "My budget this month",
  "person-day": "My budget today",
  "department-month": "My department's budget this month",
};

const dollars = (usd: number) =>
  usd.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** How much of a budget is used: amber from 80%, red when it has run out. */
function BudgetMeter({ use }: { readonly use: ControlBudgetUse }) {
  const share = use.limitUsd === null || use.limitUsd === 0 ? null : use.spentUsd / use.limitUsd;
  const tone =
    share === null
      ? "bg-primary/60"
      : share >= 1
        ? "bg-destructive"
        : share >= 0.8
          ? "bg-warning"
          : "bg-primary/60";
  return (
    <li className="space-y-1">
      <div className="flex justify-between gap-2 text-sm">
        <span>{BUDGET_NAMES[use.level]}</span>
        <span className="text-muted-foreground tabular-nums">
          {dollars(use.spentUsd)}
          {use.limitUsd === null ? " · no limit" : ` of ${dollars(use.limitUsd)}`}
        </span>
      </div>
      {share === null ? null : (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${tone}`} style={{ width: `${Math.min(1, share) * 100}%` }} />
        </div>
      )}
    </li>
  );
}

/** A person's company AI budgets, what their agents spent, and a way to ask for more. */
export function AiBudgetPanel() {
  const [usage, setUsage] = useState<ControlMyUsage | null>(null);
  const [problem, setProblem] = useState("");
  const [level, setLevel] = useState<ControlBudgetRequestLevel>("person-month");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [asked, setAsked] = useState("");
  const startedRef = useRef(false);

  const load = async () => {
    await callControl((client) => client.me.usage()).then(setUsage, (error: unknown) =>
      setProblem(controlErrorMessage(error)),
    );
  };
  const start = useEffectEvent(() => {
    void load();
  });
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- loads the person's budgets from the control server once, when the page opens
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
  }, []);

  if (usage === null) {
    return problem === "" ? null : (
      <Alert variant="error">
        <AlertDescription>{problem}</AlertDescription>
      </Alert>
    );
  }

  const limited = usage.budgets.filter((use) => use.limitUsd !== null);
  const askable = (Object.keys(ASKABLE) as Array<ControlBudgetRequestLevel>).filter((candidate) =>
    limited.some((use) => use.level === candidate),
  );
  const ask = async () => {
    const amountUsd = Number(amount.trim().replace(/^\$/u, ""));
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return setProblem("Ask for an amount in dollars, such as 50.");
    }
    if (reason.trim() === "") return setProblem("Say what the extra budget is for.");
    setProblem("");
    await callControl((client) =>
      client.me.askForBudget({ payload: { level, amountUsd, reason: reason.trim() } }),
    ).then(
      () => {
        setAsked(`You asked for ${dollars(amountUsd)} more. You will hear when it is decided.`);
        setAmount("");
        setReason("");
      },
      (error: unknown) => setProblem(controlErrorMessage(error)),
    );
  };

  return (
    <section className="mb-8 space-y-4">
      <div>
        <h2 className="text-base font-semibold">Company AI budget</h2>
        <p className="text-sm text-muted-foreground">
          What your agents spent through your company's AI accounts this month, in US dollars.
          {usage.forecastUsd === null
            ? ""
            : ` At this pace the month comes to about ${dollars(usage.forecastUsd)}.`}
          {usage.refusedCalls === 0
            ? ""
            : ` ${usage.refusedCalls} ${usage.refusedCalls === 1 ? "call was" : "calls were"} turned away.`}
        </p>
      </div>
      <ul className="space-y-3">
        {usage.budgets.map((use) => (
          <BudgetMeter key={use.level} use={use} />
        ))}
      </ul>

      {usage.models.length === 0 ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-sm font-medium">By model</p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {usage.models.map((model) => (
                <li className="flex justify-between gap-2" key={`${model.provider}:${model.model}`}>
                  <span className="truncate">{model.model}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {dollars(model.spentUsd)} · {model.calls} calls
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-medium">By day</p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {usage.days.toReversed().map((day) => (
                <li className="flex justify-between gap-2" key={day.day}>
                  <span>{day.day}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {dollars(day.spentUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {askable.length === 0 ? null : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <p className="text-sm font-medium">Ask for more</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
            <Select
              items={Object.fromEntries(
                askable.map((candidate) => [candidate, ASKABLE[candidate]]),
              )}
              onValueChange={(value) => {
                const chosen = askable.find((candidate) => candidate === value);
                if (chosen !== undefined) setLevel(chosen);
              }}
              value={askable.includes(level) ? level : askable[0]}
            >
              <SelectTrigger aria-label="Budget to ask more of" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {askable.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {ASKABLE[candidate]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Input
              aria-label="Amount in dollars"
              inputMode="decimal"
              onChange={(event) => setAmount(event.currentTarget.value)}
              placeholder="$ more"
              size="sm"
              value={amount}
            />
          </div>
          <Input
            aria-label="What it is for"
            onChange={(event) => setReason(event.currentTarget.value)}
            placeholder="What it is for, such as finishing the release review"
            size="sm"
            value={reason}
          />
          {problem === "" ? null : (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          {asked === "" ? null : (
            <Alert variant="info">
              <AlertDescription>{asked}</AlertDescription>
            </Alert>
          )}
          <Button size="sm" type="submit">
            Ask
          </Button>
        </form>
      )}
    </section>
  );
}
