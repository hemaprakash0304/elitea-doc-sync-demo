# Customer Order Management API

## Overview

Customer Order Management API is a sample Spring Boot application used to demonstrate automated technical documentation.

The application supports customer order processing and order status tracking.

## Application Details

- Application Name: Customer Order Management API
- Service Owner: Digital Engineering Team
- Business Impact: Supports customer order processing and order status tracking.
- Version: 1.0.0

## Technology Stack

- Language: Java
- Runtime: Java 17
- Framework: Spring Boot 3.2.5
- Build Tool: Maven
- Database: PostgreSQL
- ORM: Spring Data JPA

## Infrastructure

- Container Platform: Docker
- Cloud Provider: AWS
- Container Service: Amazon ECS

## Integrations

### Upstream Dependencies

- Customer Identity API

### Downstream Consumers

- Order Tracking Portal

## External APIs

- Customer Identity API

## Configuration

The application uses environment variables for runtime configuration.

Environment variable names:

- DB_HOST
- DB_PORT
- DB_NAME
- DB_USERNAME
- ORDER_SERVICE_URL

No credentials or secret values are stored in this repository.

## Testing

- Test Framework: JUnit 5
- Test Support: Spring Boot Test

## Observability

- Logging: Spring Boot application logging
- Monitoring: Not specified

## Deployment

The application is packaged as a Docker container and deployed to Amazon ECS.

## Repository

This repository contains the source and configuration used for the Customer Order Management API demonstration.
