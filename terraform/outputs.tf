###############################################################################
# terraform/outputs.tf — Infrastructure output values
###############################################################################

output "eks_cluster_name" {
  description = "EKS cluster name (used in kubectl config and CD pipeline)"
  value       = aws_eks_cluster.main.name
}

output "eks_cluster_endpoint" {
  description = "EKS API server endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "eks_cluster_ca_certificate" {
  description = "Base64-encoded CA certificate for EKS cluster"
  value       = aws_eks_cluster.main.certificate_authority[0].data
  sensitive   = true
}

output "database_url" {
  description = "PostgreSQL connection URL (store in Kubernetes secret / AWS Secrets Manager)"
  value       = "postgresql://dhub_admin:${var.rds_password}@${aws_db_instance.postgres.endpoint}/dhub?sslmode=require"
  sensitive   = true
}

output "redis_url" {
  description = "Redis connection URL"
  value       = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  sensitive   = true
}

output "s3_bucket_name" {
  description = "S3 bucket name for document object storage"
  value       = aws_s3_bucket.documents.bucket
}

output "s3_bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.documents.arn
}

output "ecr_repository_url" {
  description = "ECR repository URL for Docker image pushes"
  value       = aws_ecr_repository.dhub.repository_url
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = aws_subnet.public[*].id
}
