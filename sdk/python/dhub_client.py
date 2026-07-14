import requests
import time
from typing import Dict, List, Any, Optional

class DHubClient:
    """
    Python SDK Client for Clean Data Hub Enterprise API.
    """
    def __init__(self, base_url: str = "http://localhost:3000"):
        self.base_url = base_url.rstrip("/")
        self.token: Optional[str] = None

    def authenticate(self, email: str, password: str) -> Dict[str, Any]:
        """
        Authenticate local user credentials and store Bearer JWT token.
        """
        url = f"{self.base_url}/api/auth/login"
        payload = {"email": email, "password": password}
        response = requests.post(url, json=payload)
        response.raise_for_status()
        
        data = response.json()
        self.token = data.get("token")
        return data

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def upload_document(self, name: str, content: str, doc_type: str = "TXT", connector: str = "SDK Upload") -> Dict[str, Any]:
        """
        Upload raw text content to pipeline.
        """
        url = f"{self.base_url}/api/documents"
        payload = {
            "name": name,
            "rawContent": content,
            "type": doc_type,
            "connector": connector
        }
        response = requests.post(url, json=payload, headers=self._headers())
        response.raise_for_status()
        return response.json()

    def get_document(self, doc_id: str) -> Dict[str, Any]:
        """
        Retrieve document record details.
        """
        url = f"{self.base_url}/api/documents/{doc_id}"
        response = requests.get(url, headers=self._headers())
        response.raise_for_status()
        return response.json()

    def trigger_refinement(self, doc_id: str) -> Dict[str, Any]:
        """
        Queue refinery processing job.
        """
        url = f"{self.base_url}/api/documents/{doc_id}/refine"
        response = requests.post(url, headers=self._headers())
        response.raise_for_status()
        return response.json()

    def poll_refinement(self, doc_id: str, timeout_sec: int = 60, delay_sec: float = 2.0) -> Dict[str, Any]:
        """
        Poll document status until refinement reaches success or failure.
        """
        start = time.time()
        while time.time() - start < timeout_sec:
            doc = self.get_document(doc_id)
            status = doc.get("status")
            if status in ["refined", "failed"]:
                return doc
            time.sleep(delay_sec)
        raise TimeoutError(f"Refinement of document {doc_id} timed out after {timeout_sec} seconds")

    def get_stats(self) -> Dict[str, Any]:
        """
        Fetch tenant analytics metrics.
        """
        url = f"{self.base_url}/api/stats"
        response = requests.get(url, headers=self._headers())
        response.raise_for_status()
        return response.json()

    def upgrade_plan(self) -> Dict[str, Any]:
        """
        Upgrade tenant plan to lift free limit quotas.
        """
        url = f"{self.base_url}/api/billing/upgrade"
        response = requests.post(url, headers=self._headers())
        response.raise_for_status()
        return response.json()
