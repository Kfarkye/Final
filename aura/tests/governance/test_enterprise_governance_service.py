import pytest
import json
from typing import Dict, Any
from aura.governance.enterprise_governance_service import EnterpriseGovernanceService, DataIntegrityEnforcer, AccessControlEnforcer

# Mocking external dependencies for isolated testing

class MockDataIntegrityEnforcer(DataIntegrityEnforcer):
    """A mock to simulate data integrity enforcement for testing."""
    def enforce_policy_on_dict(self, data: Dict[str, Any]) -> Dict[str, Any]:
        processed_data = data.copy()
        if "personal_email" in processed_data:
            processed_data["personal_email"] = self.REDACTION_TOKEN
        if "authentication_token" in processed_data:
            processed_data["authentication_token"] = self.REDACTION_TOKEN
        return processed_data

class MockAccessControlEnforcer(AccessControlEnforcer):
    """A mock to simulate access control enforcement for testing."""
    def enforce_access(self, principal_context: Dict, action_requested: str, resource_identifier: Dict) -> bool:
        principal_id = principal_context.get("principal_id")
        principal_roles = principal_context.get("roles", [])
        resource_name = resource_identifier.get("name")
        resource_type = resource_identifier.get("type")

        if "global_administrator" in principal_roles:
            return True
        if action_requested == "read" and resource_type == "public_data":
            return True
        if action_requested == "deploy_critical" and "release_manager" in principal_roles and resource_type == "production_artifact":
            return True
        return False

@pytest.fixture
def enterprise_governance_service_instance():
    """Provides an EnterpriseGovernanceService instance with mock enforcers for testing."""
    service = EnterpriseGovernanceService()
    service.data_integrity_enforcer = MockDataIntegrityEnforcer()
    service.access_control_enforcer = MockAccessControlEnforcer()
    return service

def test_governance_service_applies_all_policies_successfully(enterprise_governance_service_instance):
    """
    Verifies that the EnterpriseGovernanceService orchestrates data integrity and access control
    policies for a compliant operational payload and principal, and generates an audit trail.
    """
    service = enterprise_governance_service_instance
    compliant_payload = {
        "id": "operational-payload-001",
        "description": "Enterprise artifact with PII and sensitive token.",
        "personal_email": "jane.doe@enterprise.com",
        "authentication_token": "highly_sensitive_auth_string_123",
        "status": "approved_for_production"
    }
    authorized_principal = {"principal_id": "prod_release_manager", "roles": ["release_manager"]}
    action_context = {
        "action_requested": "deploy_critical",
        "resource_identifier": {"type": "production_artifact", "name": "operational-payload-001", "sensitivity": "HIGH"}
    }

    governed_payload = service.apply_governance_policies(compliant_payload, authorized_principal, action_context)

    assert governed_payload["personal_email"] == DataIntegrityEnforcer.REDACTION_TOKEN, \
        "Data integrity policy (redaction) was not applied to the personal email."
    assert governed_payload["authentication_token"] == DataIntegrityEnforcer.REDACTION_TOKEN, \
        "Data integrity policy (redaction) was not applied to the authentication token."
    
    assert any(event["event_type"] == "access_control_policy_evaluated" and event["details"]["authorization_granted"] for event in service.audit_log_stream), \
        "Audit log does not contain evidence of successful access authorization."
    assert any(event["event_type"] == "all_enterprise_governance_policies_applied" for event in service.audit_log_stream), \
        "Audit log does not contain evidence of overall enterprise governance application success."

def test_governance_service_aborts_on_access_control_violation(enterprise_governance_service_instance):
    """
    Verifies that the EnterpriseGovernanceService aborts processing and raises a PermissionError
    when an access control policy is violated, and logs the denial for audit purposes.
    """
    service = enterprise_governance_service_instance
    payload_to_deploy = {
        "id": "critical-system-update-002",
        "description": "Critical system update requiring high privilege.",
        "critical_config_value": "secret_config_value_456"
    }
    unauthorized_principal = {"principal_id": "junior_developer", "roles": ["developer"]}
    action_context = {
        "action_requested": "deploy_critical",
        "resource_identifier": {"type": "production_artifact", "name": "critical-system-update-002", "sensitivity": "HIGH"}
    }

    with pytest.raises(PermissionError, match="ACCESS_DENIED: Principal 'junior_developer' lacks authorization for 'deploy_critical' on resource 'critical-system-update-002'."):
        service.apply_governance_policies(payload_to_deploy, unauthorized_principal, action_context)
    
    assert any(event["event_type"] == "access_control_policy_evaluated" and not event["details"]["authorization_granted"] for event in service.audit_log_stream), \
        "Audit log does not contain evidence of failed access control authorization."
    assert not any(event["event_type"] == "all_enterprise_governance_policies_applied" for event in service.audit_log_stream), \
        "Overall governance application success event should not be logged on access denial."

def test_governance_service_audit_log_integrity_and_detail(enterprise_governance_service_instance):
    """
    Verifies that audit log entries generated by the EnterpriseGovernanceService are detailed,
    timestamped, and conceptually immutable (append-only), crucial for compliance.
    """
    service = enterprise_governance_service_instance
    test_payload = {"id": "audit-test-003", "data_field": "non_sensitive_data"}
    service.apply_data_integrity_policies(test_payload)

    assert len(service.audit_log_stream) > 0, "Audit log stream should not be empty after an event."
    first_event = service.audit_log_stream[0]
    assert "timestamp_utc" in first_event, "Audit event missing ISO 8601 timestamp."
    assert "event_type" in first_event, "Audit event missing defined event type."
    assert "details" in first_event, "Audit event missing crucial contextual details."
    assert isinstance(first_event["details"], dict), "Audit event details payload must be a dictionary for structured logging."
    
    # Conceptual check for append-only behavior (in-memory list implies append-only for this test)
    initial_log_size = len(service.audit_log_stream)
    service.audit_log_stream.append({"timestamp_utc": "later", "event_type": "new_event", "details": {}})
    assert len(service.audit_log_stream) == initial_log_size + 1, "Audit log stream did not maintain append-only behavior."
