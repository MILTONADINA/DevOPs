/**
 * Proxy Request/Response Types
 *
 * See docs/TECHNICAL_SPEC.md for the authoritative schema.
 */

export interface CQProxyRequest {
  session_id: string;
  original_token_count: number;
  encrypted_payload?: EncryptedPayload;
  plaintext_payload?: PlaintextPayload;
  anthropic_request_metadata: {
    model: string;
    max_tokens: number;
    system?: string;
  };
}

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
  auth_tag: string;
  attestation_nonce: string;
}

export interface PlaintextPayload {
  messages: AnthropicMessage[];
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface CQProxyResponse {
  session_id: string;
  quarantined_token_count: number;
  anthropic_response: unknown;
  billing_record_id: string;
}
