import { describe, it, expect } from 'vitest';
import { toolRegistry } from '../registry';
import '../index'; // This imports index.ts which registers all the tools

describe('GCP Native Tools Registry', () => {
  it('should register BigQuery native tools', () => {
    expect(toolRegistry.has("list_bq_datasets_tables")).toBe(true);
    expect(toolRegistry.has("execute_bq_query")).toBe(true);
    expect(toolRegistry.has("execute_bq_sql")).toBe(true);
    expect(toolRegistry.has("insert_bq_rows")).toBe(true);
  });

  it('should register Firestore native tools', () => {
    expect(toolRegistry.has("list_firestore_collections")).toBe(true);
    expect(toolRegistry.has("get_firestore_document")).toBe(true);
    expect(toolRegistry.has("query_firestore_collection")).toBe(true);
    expect(toolRegistry.has("set_firestore_document")).toBe(true);
    expect(toolRegistry.has("update_firestore_document")).toBe(true);
    expect(toolRegistry.has("delete_firestore_document")).toBe(true);
  });

  it('should register Project IAM native tools', () => {
    expect(toolRegistry.has("get_project_iam_policy")).toBe(true);
    expect(toolRegistry.has("set_project_iam_policy")).toBe(true);
    expect(toolRegistry.has("set_project_iam_policy_binding")).toBe(true);
  });

  it('should register Cloud Trace native tools', () => {
    expect(toolRegistry.has("list_cloud_traces")).toBe(true);
    expect(toolRegistry.has("get_cloud_trace")).toBe(true);
  });
});
