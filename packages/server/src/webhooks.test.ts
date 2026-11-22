import { describe, expect, it } from "vitest";
import {
  signWebhookPayload,
  verifyGitHubWebhookSignature,
  verifyGitLabWebhookToken,
} from "./webhooks.js";

describe("incoming webhook authentication helpers", () => {
  it("verifies valid GitHub HMAC-SHA256 signatures and rejects invalid or missing ones", () => {
    const secret = "whsec_top_secret";
    const body = JSON.stringify({ check_run: { name: "ci", conclusion: "success" } });
    const validSig = signWebhookPayload(secret, body);

    expect(verifyGitHubWebhookSignature(secret, body, validSig)).toBe(true);
    expect(verifyGitHubWebhookSignature(secret, body, "sha256=deadbeef")).toBe(false);
    expect(verifyGitHubWebhookSignature(secret, body, "")).toBe(false);
    expect(verifyGitHubWebhookSignature("", body, validSig)).toBe(false);
    expect(verifyGitHubWebhookSignature(secret, body + "tampered", validSig)).toBe(false);
  });

  it("verifies GitLab X-Gitlab-Token using constant-time comparison", () => {
    expect(verifyGitLabWebhookToken("gl_secret_123", "gl_secret_123")).toBe(true);
    expect(verifyGitLabWebhookToken("gl_secret_123", "wrong")).toBe(false);
    expect(verifyGitLabWebhookToken("gl_secret_123", "")).toBe(false);
    expect(verifyGitLabWebhookToken("", "gl_secret_123")).toBe(false);
  });
});
