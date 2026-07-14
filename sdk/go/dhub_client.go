package dhub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DHubClient is the Go SDK client for Clean Data Hub Enterprise API.
type DHubClient struct {
	BaseURL string
	Token   string
	client  *http.Client
}

// NewClient creates a new Clean Data Hub API client.
func NewClient(baseURL string) *DHubClient {
	return &DHubClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: 30 * time.Second},
	}
}

// Authenticate local user credentials and store Bearer JWT token.
func (c *DHubClient) Authenticate(email, password string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/auth/login", c.BaseURL)
	payload := map[string]string{
		"email":    email,
		"password": password,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("authentication failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	if tokenVal, ok := result["token"].(string); ok {
		c.Token = tokenVal
	}

	return result, nil
}

func (c *DHubClient) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.Token))
	}
}

// UploadDocument uploads raw text content to the pipeline.
func (c *DHubClient) UploadDocument(name, content, docType, connector string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/documents", c.BaseURL)
	if docType == "" {
		docType = "TXT"
	}
	if connector == "" {
		connector = "SDK Upload"
	}

	payload := map[string]string{
		"name":       name,
		"rawContent": content,
		"type":       docType,
		"connector":  connector,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("upload failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return result, nil
}

// GetDocument retrieves document record details.
func (c *DHubClient) GetDocument(docID string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/documents/%s", c.BaseURL, docID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("getting document failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return result, nil
}

// TriggerRefinement queues a refinery processing job.
func (c *DHubClient) TriggerRefinement(docID string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/documents/%s/refine", c.BaseURL, docID)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("triggering refinement failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return result, nil
}

// PollRefinement polls document status until refinement reaches success or failure.
func (c *DHubClient) PollRefinement(docID string, timeoutSec int, delaySec float64) (map[string]interface{}, error) {
	start := time.Now()
	timeout := time.Duration(timeoutSec) * time.Second
	delay := time.Duration(delaySec * float64(time.Second))

	for time.Since(start) < timeout {
		doc, err := c.GetDocument(docID)
		if err != nil {
			return nil, err
		}

		status, ok := doc["status"].(string)
		if ok && (status == "refined" || status == "failed") {
			return doc, nil
		}

		time.Sleep(delay)
	}

	return nil, fmt.Errorf("refinement of document %s timed out after %d seconds", docID, timeoutSec)
}

// GetStats fetches tenant analytics metrics.
func (c *DHubClient) GetStats() (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/stats", c.BaseURL)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("getting stats failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return result, nil
}

// UpgradePlan upgrades tenant plan to lift free limit quotas.
func (c *DHubClient) UpgradePlan() (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/billing/upgrade", c.BaseURL)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upgrading plan failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return result, nil
}
