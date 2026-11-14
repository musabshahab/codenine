// Preload installs desktopBridge before web code runs, so module-load detection is reliable.
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

export const isSecretsFeatureEnabled = ["1", "true"].includes(
  import.meta.env.CODENINE_FEATURE_SECRETS?.trim().toLowerCase() ?? "",
);

/** A business build: people sign in at the control server that serves this app. */
export const isBusinessEdition = ["1", "true"].includes(
  import.meta.env.CODENINE_BUSINESS_EDITION?.trim().toLowerCase() ?? "",
);
