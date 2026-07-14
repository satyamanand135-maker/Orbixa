package com.dhub.sdk;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.TimeUnit;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Java SDK Client for Clean Data Hub Enterprise API.
 */
public class DHubClient {
    private final String baseUrl;
    private String token;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    public DHubClient(String baseUrl) {
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        this.objectMapper = new ObjectMapper();
    }

    /**
     * Authenticate local user credentials and store Bearer JWT token.
     */
    public Map<String, Object> authenticate(String email, String password) throws Exception {
        String url = this.baseUrl + "/api/auth/login";
        Map<String, String> payload = new HashMap<>();
        payload.put("email", email);
        payload.put("password", password);
        String jsonPayload = objectMapper.writeValueAsString(payload);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("Authentication failed with status " + response.statusCode() + ": " + response.body());
        }

        Map<String, Object> data = objectMapper.readValue(response.body(), Map.class);
        this.token = (String) data.get("token");
        return data;
    }

    private HttpRequest.Builder createBuilder(String url) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json");
        if (this.token != null) {
            builder.header("Authorization", "Bearer " + this.token);
        }
        return builder;
    }

    /**
     * Upload raw text content to pipeline.
     */
    public Map<String, Object> uploadDocument(String name, String content, String docType, String connector) throws Exception {
        String url = this.baseUrl + "/api/documents";
        Map<String, String> payload = new HashMap<>();
        payload.put("name", name);
        payload.put("rawContent", content);
        payload.put("type", docType != null ? docType : "TXT");
        payload.put("connector", connector != null ? connector : "SDK Upload");
        String jsonPayload = objectMapper.writeValueAsString(payload);

        HttpRequest request = createBuilder(url)
                .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200 && response.statusCode() != 201) {
            throw new RuntimeException("Document upload failed with status " + response.statusCode() + ": " + response.body());
        }

        return objectMapper.readValue(response.body(), Map.class);
    }

    /**
     * Retrieve document record details.
     */
    public Map<String, Object> getDocument(String docId) throws Exception {
        String url = this.baseUrl + "/api/documents/" + docId;
        HttpRequest request = createBuilder(url)
                .GET()
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("Fetching document failed with status " + response.statusCode() + ": " + response.body());
        }

        return objectMapper.readValue(response.body(), Map.class);
    }

    /**
     * Trigger refinery processing job.
     */
    public Map<String, Object> triggerRefinement(String docId) throws Exception {
        String url = this.baseUrl + "/api/documents/" + docId + "/refine";
        HttpRequest request = createBuilder(url)
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("Triggering refinement failed with status " + response.statusCode() + ": " + response.body());
        }

        return objectMapper.readValue(response.body(), Map.class);
    }

    /**
     * Poll document status until refinement reaches success or failure.
     */
    public Map<String, Object> pollRefinement(String docId, int timeoutSec, double delaySec) throws Exception {
        long start = System.currentTimeMillis();
        long timeoutMs = timeoutSec * 1000L;
        long delayMs = (long) (delaySec * 1000);

        while (System.currentTimeMillis() - start < timeoutMs) {
            Map<String, Object> doc = getDocument(docId);
            String status = (String) doc.get("status");
            if ("refined".equals(status) || "failed".equals(status)) {
                return doc;
            }
            TimeUnit.MILLISECONDS.sleep(delayMs);
        }
        throw new RuntimeException("Refinement of document " + docId + " timed out after " + timeoutSec + " seconds");
    }

    /**
     * Fetch tenant analytics metrics.
     */
    public Map<String, Object> getStats() throws Exception {
        String url = this.baseUrl + "/api/stats";
        HttpRequest request = createBuilder(url)
                .GET()
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("Fetching statistics failed with status " + response.statusCode() + ": " + response.body());
        }

        return objectMapper.readValue(response.body(), Map.class);
    }

    /**
     * Upgrade tenant plan to lift free limit quotas.
     */
    public Map<String, Object> upgradePlan() throws Exception {
        String url = this.baseUrl + "/api/billing/upgrade";
        HttpRequest request = createBuilder(url)
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("Upgrading plan failed with status " + response.statusCode() + ": " + response.body());
        }

        return objectMapper.readValue(response.body(), Map.class);
    }
}
