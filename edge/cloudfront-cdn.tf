# ─────────────────────────────────────────────────────────────────────────────
# AWS CloudFront CDN & WAF Bot Control Infrastructure (Terraform)
# High-Concurrency Flash Sale Edge Architecture
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "domain_name" {
  type        = string
  default     = "flashsale.example.com"
  description = "Apex domain name for the flash sale event"
}

variable "alb_origin_dns" {
  type        = string
  default     = "flash-sale-alb-123456789.us-east-1.elb.amazonaws.com"
  description = "DNS endpoint of the AWS Application Load Balancer"
}

# ─── 1. AWS WAF Web ACL (Bot Protection & Rate Limiting) ───
resource "aws_wafv2_web_acl" "flash_sale_waf" {
  name        = "flash-sale-edge-waf"
  description = "Protects flash sale origin from bot flooding and DDoS"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Rule 1: AWS Managed Common Rule Set (blocks OWASP Top 10 vulnerabilities)
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "CommonRuleSetMetric"
      sampled_requests_enabled   = true
    }
  }

  # Rule 2: AWS Managed Bot Control (blocks scrapers, puppeteer, automated scripts)
  rule {
    name     = "AWSManagedRulesBotControlRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesBotControlRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "BotControlMetric"
      sampled_requests_enabled   = true
    }
  }

  # Rule 3: Strict Edge Rate Limiting (100 requests per 5 minutes per IP on checkout)
  rule {
    name     = "CheckoutRateLimitingRule"
    priority = 3

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate_limit_body"
        }
      }
    }

    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            field_to_match {
              uri_path {}
            }
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/v1/checkout"
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "CheckoutRateLimitMetric"
      sampled_requests_enabled   = true
    }
  }

  custom_response_body {
    key          = "rate_limit_body"
    content_type = "APPLICATION_JSON"
    content      = "{\"error\":\"EDGE_RATE_LIMITED\",\"message\":\"Too many requests hitting checkout at the edge. Slow down.\"}"
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "FlashSaleWAFMetric"
    sampled_requests_enabled   = true
  }
}

# ─── 2. CloudFront Edge Cache Policy (Static Assets: 24h TTL) ───
resource "aws_cloudfront_cache_policy" "static_assets_policy" {
  name        = "FlashSaleStaticAssetsPolicy"
  comment     = "Caches HTML, CSS, JS, and product images at edge PoPs for 24 hours"
  default_ttl = 86400
  max_ttl     = 604800
  min_ttl     = 3600

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# ─── 3. CloudFront Distribution (Edge CDN) ───
resource "aws_cloudfront_distribution" "flash_sale_cdn" {
  comment             = "Edge CDN for High-Concurrency Festival Flash Sale"
  enabled             = true
  is_ipv6_enabled     = true
  price_class         = "PriceClass_All" # Uses all 300+ global edge locations
  web_acl_id          = aws_wafv2_web_acl.flash_sale_waf.arn

  # Origin: AWS Application Load Balancer
  origin {
    domain_name = var.alb_origin_dns
    origin_id   = "ALB-Origin"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_keepalive_timeout = 60
      origin_read_timeout      = 30
    }
  }

  # Default Cache Behavior (Static Shell & Assets: Caches at Edge)
  default_cache_behavior {
    target_origin_id       = "ALB-Origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = aws_cloudfront_cache_policy.static_assets_policy.id
  }

  # Dynamic API Path Behavior (/api/*: Pass through to ALB, No Edge Caching)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "ALB-Origin"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed CachingDisabled Policy (ID: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad)
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    # Managed AllViewer Policy (forwards Authorization, X-Idempotency-Key headers)
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

output "cdn_domain_name" {
  value       = aws_cloudfront_distribution.flash_sale_cdn.domain_name
  description = "Public CloudFront CDN domain name"
}

