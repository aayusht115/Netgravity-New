@description('Container image for the Python backend, including registry hostname and tag.')
param backendImage string

@description('Container image for the Next.js frontend, including registry hostname and tag.')
param frontendImage string

@description('Name of the existing Azure Container Registry that stores both images.')
param containerRegistryName string

param location string = resourceGroup().location
param appName string = 'netgravity'
param storageAccountName string = toLower(take(replace('${appName}${uniqueString(resourceGroup().id)}', '-', ''), 24))

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: { retentionInDays: 30 }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-environment'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 14 }
    isVersioningEnabled: true
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in ['netgravity-state', 'raw', 'standardized', 'curated']: {
  parent: blobService
  name: name
  properties: { publicAccess: 'None' }
}]

resource backend 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-api'
  location: location
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      secrets: [
        {
          name: 'registry-password'
          value: registry.listCredentials().passwords[0].value
        }
        {
          name: 'storage-connection-string'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${az.environment().suffixes.storage}'
        }
      ]
      registries: [{
        server: registry.properties.loginServer
        username: registry.listCredentials().username
        passwordSecretRef: 'registry-password'
      }]
      // Cookie affinity is supported only in single-revision HTTP mode.
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
        allowInsecure: false
        // Durable registries synchronize through Blob. Affinity keeps a
        // client's short-lived in-flight execution context on one replica.
        stickySessions: { affinity: 'sticky' }
      }
    }
    template: {
      containers: [{
        name: 'api'
        image: backendImage
        env: [
          { name: 'PORT', value: '8000' }
          { name: 'NETGRAVITY_ENV', value: 'production' }
          { name: 'NETGRAVITY_PUBLIC_URL', value: 'https://${appName}-web.${environment.properties.defaultDomain}' }
          { name: 'NETGRAVITY_STATE_BACKEND', value: 'azure_blob' }
          { name: 'NETGRAVITY_STORAGE_BACKEND', value: 'azure_blob' }
          { name: 'NETGRAVITY_AZURE_CONN_STR', secretRef: 'storage-connection-string' }
          { name: 'NETGRAVITY_AZURE_STATE_CONTAINER', value: 'netgravity-state' }
        ]
        resources: { cpu: json('1.0'), memory: '2Gi' }
      }]
      scale: {
        minReplicas: 1
        maxReplicas: 4
        rules: [{
          name: 'http-concurrency'
          http: {
            // One replica has four gunicorn request threads.
            metadata: { concurrentRequests: '4' }
          }
        }]
      }
    }
  }
}

resource frontend 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-web'
  location: location
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      secrets: [{
        name: 'registry-password'
        value: registry.listCredentials().passwords[0].value
      }]
      registries: [{
        server: registry.properties.loginServer
        username: registry.listCredentials().username
        passwordSecretRef: 'registry-password'
      }]
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [{
        name: 'web'
        image: frontendImage
        env: [{
          name: 'PYTHON_API_URL'
          value: 'https://${backend.properties.configuration.ingress.fqdn}'
        }]
        resources: { cpu: json('0.5'), memory: '1Gi' }
      }]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

output frontendUrl string = 'https://${frontend.properties.configuration.ingress.fqdn}'
output backendUrl string = 'https://${backend.properties.configuration.ingress.fqdn}'
output storageAccount string = storage.name
