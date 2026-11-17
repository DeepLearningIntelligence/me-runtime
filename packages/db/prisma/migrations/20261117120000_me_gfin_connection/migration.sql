-- Sole statement so the existing journal remains writable during index creation.
-- Indexes the provisioned connection's convergence lookup (owner + slug), which every
-- workspace admission runs.
CREATE INDEX "mcp_servers_user_id_slug_idx" ON "mcp_servers"("userId", "slug");
