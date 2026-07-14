# terraform/environments/dev.tfvars
environment            = "dev"
aws_region             = "us-east-1"
vpc_cidr               = "10.0.0.0/16"
availability_zones     = ["us-east-1a", "us-east-1b"]
eks_version            = "1.29"
eks_node_instance_type = "t3.medium"
eks_desired_nodes      = 2
eks_min_nodes          = 1
eks_max_nodes          = 4
rds_instance_class     = "db.t3.small"
rds_storage_gb         = 20
rds_password           = "CHANGE_ME_dev_password"
redis_node_type        = "cache.t3.micro"
