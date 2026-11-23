import type {
  EnvironmentId,
  MediaModelRef,
  MediaOverview,
  MediaProvider,
} from "@codenine/contracts";
import { AuthSettingsWriteScope } from "@codenine/contracts";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CHEAPEST = "cheapest";
const MAX_LIMIT_USD = 100_000;

const usd = (value: number) =>
  `$${value.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    // Some images cost a fraction of a cent.
    maximumFractionDigits: value > 0 && value < 0.1 ? 3 : 2,
  })}`;

const modelKey = (ref: MediaModelRef) => `${ref.provider}\n${ref.model}`;

function providerSummary(provider: MediaProvider): string {
  if (!provider.configured) return provider.setup.hint;
  const prices = provider.models.flatMap((model) =>
    model.estimatedUsdPerImage === null ? [] : [model.estimatedUsdPerImage],
  );
  const models = `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`;
  return prices.length === 0
    ? `Ready. ${models}.`
    : `Ready. ${models}, from about ${usd(Math.min(...prices))} an image.`;
}

/** A dollar amount that saves when the field commits, so typing 25 never saves 2 on the way. */
function UsdLimitField(props: {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(props.value);
  const [source, setSource] = useState(props.value);
  if (source !== props.value) {
    setSource(props.value);
    setDraft(props.value);
  }
  return (
    <NumberField
      size="sm"
      className="w-32"
      min={0}
      max={MAX_LIMIT_USD}
      step={props.step}
      format={{ style: "currency", currency: "USD" }}
      disabled={props.disabled}
      value={draft}
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) {
          setDraft(props.value);
          return;
        }
        const value = Math.round(Math.min(MAX_LIMIT_USD, Math.max(0, next)) * 100) / 100;
        setDraft(value);
        if (value !== props.value) props.onCommit(value);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Lower the ${props.label}`} />
        <NumberFieldInput aria-label={`${props.label} in US dollars`} />
        <NumberFieldIncrement aria-label={`Raise the ${props.label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

function ProviderRow({ provider }: { readonly provider: MediaProvider }) {
  return (
    <SettingsRow
      title={provider.name}
      description={providerSummary(provider)}
      control={
        provider.configured ? (
          <Badge variant="success">Ready</Badge>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            {provider.setup.where === "connectors" ? (
              <InlineButton render={<Link to="/connectors" />}>Open Connectors</InlineButton>
            ) : (
              <span className="text-muted-foreground">Add it under Accounts, above</span>
            )}
            <InlineButton
              render={<a href={provider.keyUrl} target="_blank" rel="noreferrer noopener" />}
            >
              Get a key
            </InlineButton>
          </div>
        )
      }
    />
  );
}

function DefaultModelRow(props: {
  readonly overview: MediaOverview;
  readonly saved: MediaModelRef | null;
  readonly disabled: boolean;
  readonly onChange: (model: MediaModelRef | null) => void;
}) {
  const choices = props.overview.providers
    .filter((provider) => provider.configured)
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.textToImage)
        .map((model) => ({
          ref: { provider: provider.id, model: model.id },
          label: `${model.name} (${provider.name})`,
          price: model.estimatedUsdPerImage,
        })),
    );
  const labels = new Map(choices.map((choice) => [modelKey(choice.ref), choice.label]));
  const inUse = props.overview.defaultModel;
  const savedKey =
    props.saved !== null && labels.has(modelKey(props.saved)) ? modelKey(props.saved) : CHEAPEST;
  return (
    <SettingsRow
      title="Default model"
      description={
        inUse === null
          ? "Add a provider key to choose a model."
          : "Used when a request names no model. An edit uses the cheapest model that can edit when this one cannot."
      }
      control={
        <Select
          value={savedKey}
          disabled={props.disabled || choices.length === 0}
          onValueChange={(value) => {
            const choice = choices.find((candidate) => modelKey(candidate.ref) === value);
            props.onChange(choice?.ref ?? null);
          }}
        >
          <SelectTrigger size="sm" aria-label="Default image model">
            <SelectValue>
              {(value: string | null) =>
                value === null || value === CHEAPEST
                  ? inUse === null
                    ? "None yet"
                    : `Cheapest: ${labels.get(modelKey(inUse)) ?? inUse.model}`
                  : (labels.get(value) ?? value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={CHEAPEST}>Cheapest available</SelectItem>
            {choices.map((choice) => (
              <SelectItem key={modelKey(choice.ref)} value={modelKey(choice.ref)}>
                {choice.price === null
                  ? choice.label
                  : `${choice.label}, about ${usd(choice.price)}`}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * Image providers of one environment: which have a key, the model and spending limits used,
 * and what this month has cost. The keys themselves are added where Codenine already keeps them.
 */
export function MediaSettings({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = serverConfig?.environment.capabilities.imageGeneration === true;
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope) && !readOnly;
  const { data: overview, error } = useEnvironmentQuery(
    supported ? serverEnvironment.mediaOverview({ environmentId, input: {} }) : null,
  );
  if (!supported) return null;
  const media = settings.media;
  const anyConfigured = overview?.providers.some((provider) => provider.configured) === true;

  return (
    <SettingsSection {...searchableSetting("media")}>
      {overview === undefined || overview === null ? (
        <SettingsRow
          title={error === null ? "Loading image providers" : "Image providers could not be loaded"}
          description={
            error === null
              ? undefined
              : "Check the connection to this computer, then reopen Settings."
          }
        />
      ) : (
        <>
          {anyConfigured ? null : (
            <SettingsRow
              title="No image provider yet"
              description="Images are made by a provider you choose and billed to your account with them. Add a key for one of the providers below. Until then Codenine makes no images and contacts no provider."
            />
          )}
          {overview.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
          <DefaultModelRow
            overview={overview}
            saved={media.defaultModel}
            disabled={!canWrite}
            onChange={(defaultModel) => updateSettings({ media: { defaultModel } })}
          />
          <SettingsRow
            title="Monthly limit"
            description="The most this computer spends on images in a calendar month (UTC), for you and your agents together. A request that would pass it is refused before any provider is called. Set 0 to turn images off."
            control={
              <UsdLimitField
                label="monthly image limit"
                value={media.monthlyLimitUsd}
                step={1}
                disabled={!canWrite}
                onCommit={(monthlyLimitUsd) => updateSettings({ media: { monthlyLimitUsd } })}
              />
            }
          />
          <SettingsRow
            title="Limit for one request"
            description="The most one request may cost: the number of images times the model's estimated price."
            control={
              <UsdLimitField
                label="limit for one image request"
                value={media.perRequestLimitUsd}
                step={0.1}
                disabled={!canWrite}
                onCommit={(perRequestLimitUsd) => updateSettings({ media: { perRequestLimitUsd } })}
              />
            }
          />
          <SettingsRow
            title="This month"
            description={`${usd(overview.usage.spentUsd)} of ${usd(overview.limits.monthlyLimitUsd)} spent on ${overview.usage.images} ${overview.usage.images === 1 ? "image" : "images"}. Where a provider does not report a price, its estimate is counted.`}
          />
        </>
      )}
    </SettingsSection>
  );
}
