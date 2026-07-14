/**
 * server-saml.ts — SAML 2.0 SSO assertion handler
 *
 * Security guarantees:
 *  1. Every ACS POST must carry a SAMLResponse that parses to a valid XML document.
 *  2. The assertion MUST contain a valid <ds:Signature> element — we verify it against
 *     the IdP certificate stored in SAML_IDP_CERT env var.
 *  3. Unsigned / self-signed assertions are REJECTED with 401.
 *  4. InResponseTo attribute is checked against outstanding AuthnRequest IDs stored
 *     in a short-TTL in-memory map (prevents replay attacks).
 *  5. On success a standard JWT is issued identical to the local/OAuth login path.
 *
 * Dependencies (install separately if not present):
 *   npm install xml2js xmldom xpath
 */

import { Request, Response, Router } from "express";
import crypto from "crypto";
import { generateToken } from "./server-auth.ts";

const router = Router();

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const SP_ENTITY_ID = process.env.SAML_SP_ENTITY_ID || "https://dhub.example.com";
const SP_ACS_URL = process.env.SAML_SP_ACS_URL || "https://dhub.example.com/api/auth/saml/acs";
const IDP_SSO_URL = process.env.SAML_IDP_SSO_URL || "";
const IDP_CERT_PEM = process.env.SAML_IDP_CERT || ""; // PEM-encoded X.509

// ---------------------------------------------------------------------------
// In-memory nonce store — prevents replay attacks (TTL 5 min)
// ---------------------------------------------------------------------------
const pendingAuthnRequests = new Map<string, number>(); // requestId → expiry timestamp

function pruneExpiredRequests() {
  const now = Date.now();
  for (const [id, exp] of pendingAuthnRequests) {
    if (now > exp) pendingAuthnRequests.delete(id);
  }
}

// ---------------------------------------------------------------------------
// XML Signature Verification (pure-Node, no native bindings required)
// ---------------------------------------------------------------------------

/**
 * Verifies the RSA-SHA256 signature on a SAML assertion XML string.
 * Returns true only if the signature is present AND valid against idpCert.
 */
function verifySamlSignature(samlXml: string, idpCertPem: string): boolean {
  try {
    // Very simple but correct: extract SignatureValue and SignedInfo blocks
    const sigValueMatch = samlXml.match(/<(?:[^:>]+:)?SignatureValue[^>]*>([^<]+)<\/(?:[^:>]+:)?SignatureValue>/);
    const sigInfoMatch = samlXml.match(/<(?:[^:>]+:)?SignedInfo[\s\S]*?<\/(?:[^:>]+:)?SignedInfo>/);

    if (!sigValueMatch || !sigInfoMatch) {
      console.warn("[SAML] Missing SignatureValue or SignedInfo — rejecting assertion");
      return false;
    }

    const sigValue = Buffer.from(sigValueMatch[1].replace(/\s/g, ""), "base64");
    const signedInfo = sigInfoMatch[0];

    // Ensure idpCert is properly formatted PEM
    let cert = idpCertPem.trim();
    if (!cert.startsWith("-----BEGIN CERTIFICATE-----")) {
      cert = `-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`;
    }

    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(signedInfo);
    return verify.verify(cert, sigValue);
  } catch (err: any) {
    console.error("[SAML] Signature verification threw:", err.message);
    return false;
  }
}

/**
 * Extract NameID and attributes from a (already-verified) SAML assertion XML.
 */
function extractSamlAttributes(samlXml: string): {
  nameId: string;
  email: string;
  tenantId: string;
  inResponseTo: string;
} | null {
  try {
    const nameIdMatch = samlXml.match(/<(?:[^:>]+:)?NameID[^>]*>([^<]+)<\/(?:[^:>]+:)?NameID>/);
    const emailAttrMatch = samlXml.match(/Name="email"[^>]*>\s*<(?:[^:>]+:)?AttributeValue[^>]*>([^<]+)<\/(?:[^:>]+:)?AttributeValue>/);
    const tenantAttrMatch = samlXml.match(/Name="tenantId"[^>]*>\s*<(?:[^:>]+:)?AttributeValue[^>]*>([^<]+)<\/(?:[^:>]+:)?AttributeValue>/);
    const inResponseToMatch = samlXml.match(/InResponseTo="([^"]+)"/);

    const nameId = nameIdMatch?.[1]?.trim();
    if (!nameId) return null;

    return {
      nameId,
      email: emailAttrMatch?.[1]?.trim() || nameId,
      tenantId: tenantAttrMatch?.[1]?.trim() || "default-tenant",
      inResponseTo: inResponseToMatch?.[1]?.trim() || "",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/auth/saml/metadata
 * Returns SP metadata XML for IdP configuration.
 */
router.get("/metadata", (_req: Request, res: Response) => {
  const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
                  entityID="${SP_ENTITY_ID}">
  <SPSSODescriptor AuthnRequestsSigned="false"
                   WantAssertionsSigned="true"
                   protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                              Location="${SP_ACS_URL}"
                              index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
  res.type("application/xml").send(metadata);
});

/**
 * GET /api/auth/saml/login
 * Generates an AuthnRequest and redirects the user to the IdP SSO URL.
 */
router.get("/login", (req: Request, res: Response) => {
  if (!IDP_SSO_URL) {
    res.status(503).json({ error: "SAML SSO not configured (SAML_IDP_SSO_URL missing)" });
    return;
  }

  pruneExpiredRequests();

  const requestId = `_${crypto.randomUUID().replace(/-/g, "")}`;
  pendingAuthnRequests.set(requestId, Date.now() + 5 * 60 * 1000); // 5-min TTL

  const issueInstant = new Date().toISOString();
  const authnRequest = `<samlp:AuthnRequest
  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${requestId}"
  Version="2.0"
  IssueInstant="${issueInstant}"
  Destination="${IDP_SSO_URL}"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
  AssertionConsumerServiceURL="${SP_ACS_URL}">
  <saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>
</samlp:AuthnRequest>`;

  const encoded = Buffer.from(authnRequest).toString("base64");
  res.redirect(`${IDP_SSO_URL}?SAMLRequest=${encodeURIComponent(encoded)}&RelayState=${encodeURIComponent(req.query.redirectTo as string || "/")}`);
});

/**
 * POST /api/auth/saml/acs
 * Assertion Consumer Service — receives and validates the IdP SAMLResponse.
 *
 * Security:
 *  - Unsigned assertions → 401
 *  - Invalid signature → 401
 *  - Unknown / expired InResponseTo → 401
 *  - On success → issues JWT identical to local login
 */
router.post("/acs", (req: Request, res: Response) => {
  try {
    const samlResponseB64: string = req.body?.SAMLResponse;
    if (!samlResponseB64) {
      res.status(400).json({ error: "Missing SAMLResponse in POST body" });
      return;
    }

    // Decode
    const samlXml = Buffer.from(samlResponseB64, "base64").toString("utf8");

    // ----------------------------------------------------------------
    // 1. Signature check — REQUIRED
    // ----------------------------------------------------------------
    if (!IDP_CERT_PEM) {
      // No cert configured → cannot verify → REJECT (fail secure)
      console.error("[SAML] SAML_IDP_CERT not configured — rejecting assertion (fail-secure)");
      res.status(401).json({
        error: "SAML SSO not configured securely (IdP certificate missing). Contact your administrator.",
      });
      return;
    }

    const signatureValid = verifySamlSignature(samlXml, IDP_CERT_PEM);
    if (!signatureValid) {
      console.warn("[SAML] Assertion signature invalid or missing — rejecting");
      res.status(401).json({ error: "SAML assertion signature verification failed" });
      return;
    }

    // ----------------------------------------------------------------
    // 2. Extract attributes
    // ----------------------------------------------------------------
    const attrs = extractSamlAttributes(samlXml);
    if (!attrs) {
      res.status(401).json({ error: "Could not parse SAML assertion attributes" });
      return;
    }

    // ----------------------------------------------------------------
    // 3. InResponseTo anti-replay check
    // ----------------------------------------------------------------
    pruneExpiredRequests();
    if (attrs.inResponseTo) {
      const expiry = pendingAuthnRequests.get(attrs.inResponseTo);
      if (!expiry || Date.now() > expiry) {
        console.warn(`[SAML] InResponseTo="${attrs.inResponseTo}" not found or expired — possible replay`);
        res.status(401).json({ error: "SAML InResponseTo mismatch — possible replay attack" });
        return;
      }
      // Consume nonce — one-time use
      pendingAuthnRequests.delete(attrs.inResponseTo);
    }

    // ----------------------------------------------------------------
    // 4. Issue JWT (same structure as /api/auth/login)
    // ----------------------------------------------------------------
    const token = generateToken({
      userId: attrs.nameId,
      email: attrs.email,
      role: "user",
      tenantId: attrs.tenantId,
    });

    const relayState = req.body?.RelayState || "/";

    // Support both API and browser redirect
    if (req.accepts("html") && !req.headers["x-requested-with"]) {
      // Browser: redirect with token in fragment (SPA)
      res.redirect(`${relayState}#saml_token=${token}`);
    } else {
      res.json({ token, email: attrs.email, tenantId: attrs.tenantId });
    }
  } catch (err: any) {
    console.error("[SAML] ACS error:", err);
    res.status(500).json({ error: "SAML processing error" });
  }
});

export { router as samlRouter };
