// @effect-diagnostics nodeBuiltinImport:off - signs test tokens and assertions as an identity provider does.
import * as NodeCrypto from "node:crypto";

import type * as client from "openid-client";
import { SignedXml } from "xml-crypto";

/** A stand-in OIDC provider that tests reach through `SsoFetch`, with no network. */
export const TEST_OIDC_ISSUER = "https://idp.acme.test";

/** Wide enough that no test depends on the clock. */
const ISSUED_AT = 1_000_000_000;
const EXPIRES_AT = 4_000_000_000;

export const testOidcProvider = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = (claims: Readonly<Record<string, unknown>>) => {
    const signed = `${encode({ alg: "RS256", kid: "test", typ: "JWT" })}.${encode({
      iss: TEST_OIDC_ISSUER,
      iat: ISSUED_AT,
      exp: EXPIRES_AT,
      ...claims,
    })}`;
    return `${signed}.${NodeCrypto.sign("sha256", Buffer.from(signed), privateKey).toString("base64url")}`;
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const answer = { claims: {} as Readonly<Record<string, unknown>> };
  const fetch: client.CustomFetch = async (url) => {
    switch (new URL(url).pathname) {
      case "/.well-known/openid-configuration":
        return json({
          issuer: TEST_OIDC_ISSUER,
          authorization_endpoint: `${TEST_OIDC_ISSUER}/authorize`,
          token_endpoint: `${TEST_OIDC_ISSUER}/token`,
          jwks_uri: `${TEST_OIDC_ISSUER}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        });
      case "/jwks":
        return json({ keys: [jwk] });
      case "/token":
        return json({
          access_token: "access",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken(answer.claims),
        });
      default:
        return new Response("Not found", { status: 404 });
    }
  };
  return {
    fetch,
    /** The ID token's claims for the next code exchanged, beside its issuer and times. */
    answerWith: (claims: Readonly<Record<string, unknown>>) => {
      answer.claims = claims;
    },
  };
};

/** A test identity provider's signing key and certificate, valid until 2126. */
export const SAML_IDP_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCWeuNrpr6CuLmQ
6RR2VnYAPBoBEEVDQejkF6+dp5QR44ke0+EBucxpVij18UIAKPdalpUde+m79zYm
3NuiheizfHM1uEgvjc/JbswOh2MnbPdTqv40ZMRP8dt6TdD38J+ddm9qUivfeLMl
LhMKk8AW7l+i0ry7ID28EIcS3500C9y5pShkd4kopzM+2ItrXknNMt05Wd7wMsZr
U1s8oMVq2uZCzymuzB4v2yXaYZo6hujTW3KhGoT31T/xWLFM7i8C+ktcjmgx8MrI
vEC9nHLXE4SWTjpLux00t4pOSgjivHHzrt4gOxTRqK9bthu3wSFShJUcLKF1G/Wu
9PwQLuH1AgMBAAECggEADi8CmR7EJbumKAnEJzxSjoabt95x/NstSbSO1cgaHY6K
GekENB6wbPxVS4tEOpIh8HyxjPAlUZWFWefm3tyK2MIh9N4MFcli3LxwCO2Lc8ei
T1VWdRdLZrKoCpDjob8hOF0VttqMbpmonxhG7LANAsxQoN8GsYeiMgQHy0he/6z6
ibmf8bNEmd0Pi9uc5OQpwXmWmmc6Dq30/j5xvJGL9H3p84md4q/QkTLLUTgq4+PZ
nRaCdFs10yrjBULFy02M2mSN17g1e88w1VLk+HbtOKZOYW3B8ZmZkAKaX+wtTCU0
sd5FAHq2ttR6QmWjXbN12tlUDXsXL09S7U2EQqLh+QKBgQDKyksXQhBEitzBDep/
lQJIeGP+Tubj/E4ylI/WX9mFOKlD/jsWeVGuRfkVOGcXMEqbPGGWEp9aT2lGsVxF
ViN8ihuqcGwC9tKg6ah4ZY4lmGbL7ZVFYW4PTvwk0o8G/2ItrRyDl/7afQ8RTghI
8xst1aHBsZD3pr4sZZNJA5/QiQKBgQC99tidV1ukLVSGhaGq9zCT7ZI6GYuMAUSP
r7T2kcbN5Xf+ulWKqhQYUxce9fugU7acGtx/c5FcpHnZWpnBZ51iQJ2N5jyupTam
bQdbwAIMPUEQJ6pH8MuXheO+z7N0q4+G3DNva09Vy2r1vYieLI/W2+qMbvwSeRaB
g3cp+NYzDQKBgHnfHUW7BD/NHGJBVL6b9KVNBPsevBAj33LyaYcyT22K4d7k+OnG
u1n633jrTrlW4l9s6FDinDYQJ3q+uG9LF0SPU5UYvzEA2RCvm/nPPqBFePHxtJXf
ud8lXs9aY26XKI++y7YiMJ1qLxX9SWleAOWI0A+yASd0ZDIWUW+959vRAoGAbNg2
b5jxYlWy281Pv7UY+XmjUnT2l0bWsPm9V5ZZcfosUiEUCHrBPtrFIbFR9yBgPnvJ
oaFnRczcIGUgOkgTTou1euvUE0GI2b0Y/UI8KiUi1Y3UrJnVHcHSp688pPn0KBKd
yhaTg5YleB6cW/0uga7KaqLg/fixo43fRoZUvTUCgYBp2Q5yyMhQV+IPJxUkxoPS
AOJdPKODmRNQZ7l0+j2rBiYsDhk1dimu4vwYjKqEjMCIuGNNQzfgSywJpCCO48yx
Y+et/Uh63OBcYjb4Bj95eiX3AXtUdXat0I1YmUgjUM+Oi9bdFa3EUlcHMBJiq2Vv
m4Hvq16+RQ5nx5Lk7cMCNg==
-----END PRIVATE KEY-----`;
export const SAML_IDP_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDNzCCAh+gAwIBAgIUCJ5ZxXwwoxhS/7y/+mc6RCJrwTQwDQYJKoZIhvcNAQEL
BQAwKjEoMCYGA1UEAwwfQ29kZW5pbmUgdGVzdCBpZGVudGl0eSBwcm92aWRlcjAg
Fw0yNjExMTUxMTI2MjJaGA8yMTI2MTAyMjExMjYyMlowKjEoMCYGA1UEAwwfQ29k
ZW5pbmUgdGVzdCBpZGVudGl0eSBwcm92aWRlcjCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAJZ642umvoK4uZDpFHZWdgA8GgEQRUNB6OQXr52nlBHjiR7T
4QG5zGlWKPXxQgAo91qWlR176bv3Nibc26KF6LN8czW4SC+Nz8luzA6HYyds91Oq
/jRkxE/x23pN0Pfwn512b2pSK994syUuEwqTwBbuX6LSvLsgPbwQhxLfnTQL3Lml
KGR3iSinMz7Yi2teSc0y3TlZ3vAyxmtTWzygxWra5kLPKa7MHi/bJdphmjqG6NNb
cqEahPfVP/FYsUzuLwL6S1yOaDHwysi8QL2cctcThJZOOku7HTS3ik5KCOK8cfOu
3iA7FNGor1u2G7fBIVKElRwsoXUb9a70/BAu4fUCAwEAAaNTMFEwHQYDVR0OBBYE
FGR3MlpQ0VGW1K6cDYEWNkCPfY78MB8GA1UdIwQYMBaAFGR3MlpQ0VGW1K6cDYEW
NkCPfY78MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBADeKMOwK
gg7Dk5luEe8BeoRorQXvvN+spvI8S9NyP4yAdoBRRVXwtjSFbuAWQVUVqN5obrt+
GZCeTPeHGh1M2Qww0ppNHsWOUnAgpQNa/VV2r/MTsGPiLjHhFDGGugk5ezb+t3ic
Cjljg+lGo4gqx8CyKdTbZm5BKFTQnj2YCO5NSerSOBp7/4k2jibwcZ7U9bQvRtBb
qYEIICStmxtAGBassmMRFqLcjpoLGnuOoqcsSTck3HNtvKts8yUGoEPJQQGBV/DT
cECKO0RXQDDTcoX9KdAraaC0nrz8nnzULnnF6LSjn31c19reObwmyBtX5PnFO+A0
6Z7/KPZBw5ajEXo=
-----END CERTIFICATE-----`;
export const TEST_SAML_ISSUER = "https://idp.acme.test/saml";

/** A SAML response as Entra ID sends one, with its assertion signed unless asked not to. */
export const samlResponse = (input: {
  readonly inResponseTo: string;
  readonly acs: string;
  readonly audience: string;
  readonly nameId: string;
  readonly email: string;
  readonly groups: ReadonlyArray<string>;
  readonly signed?: boolean;
}) => {
  const values = (name: string, items: ReadonlyArray<string>) =>
    `<saml:Attribute Name="${name}">${items
      .map((item) => `<saml:AttributeValue>${item}</saml:AttributeValue>`)
      .join("")}</saml:Attribute>`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="2026-12-10T12:00:00Z" Destination="${input.acs}" InResponseTo="${input.inResponseTo}">` +
    `<saml:Issuer>${TEST_SAML_ISSUER}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="_assertion" Version="2.0" IssueInstant="2026-12-10T12:00:00Z">` +
    `<saml:Issuer>${TEST_SAML_ISSUER}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${input.nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${input.inResponseTo}" NotOnOrAfter="2100-01-01T00:00:00Z" Recipient="${input.acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="2000-01-01T00:00:00Z" NotOnOrAfter="2100-01-01T00:00:00Z"><saml:AudienceRestriction><saml:Audience>${input.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="2026-12-10T12:00:00Z" SessionIndex="_session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${values("email", [input.email])}${values("displayName", ["Sam Example"])}${values("groups", input.groups)}</saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  if (input.signed === false) return xml;
  const signer = new SignedXml({
    privateKey: SAML_IDP_KEY,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });
  signer.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    location: {
      reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: "after",
    },
  });
  return signer.getSignedXml();
};
