@description('Azure region')
param location string = resourceGroup().location

@description('Container image for the WhiteBoard backend, for example myregistry.azurecr.io/whiteboard-server:latest')
param image string

@description('Container registry server, for example myregistry.azurecr.io')
param registryServer string

@description('Container registry username')
param registryUsername string

@secure()
@description('Container registry password')
param registryPassword string

@secure()
@description('Azure OpenAI API key')
param azureOpenAIKey string

@description('Azure OpenAI endpoint')
param azureOpenAIEndpoint string

@description('Azure OpenAI deployment name')
param azureOpenAIDeployment string

@description('Azure OpenAI API version')
param azureOpenAIApiVersion string = '2024-12-01-preview'

@secure()
@description('Azure AI Speech key')
param azureSpeechKey string

@description('Azure AI Speech region')
param azureSpeechRegion string = 'eastus'

@description('Container App name')
param appName string = 'whiteboard-backend'

var logName = '${appName}-logs'
var envName = '${appName}-env'
var storageName = toLower(replace('${uniqueString(resourceGroup().id, appName)}wb', '-', ''))
var shareName = 'whiteboard-data'

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: 5
  }
}

resource env 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: envName
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

resource envStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: env
  name: 'whiteboardfiles'
  dependsOn: [
    share
  ]
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

resource app 'Microsoft.App/containerApps@2023-05-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: env.id
    template: {
      containers: [
        {
          name: 'server'
          image: image
          env: [
            { name: 'PORT', value: '8787' }
            { name: 'STORE', value: 'file' }
            { name: 'FILE_STORE_PATH', value: '/app/data/boards.json' }
            { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAIEndpoint }
            { name: 'AZURE_OPENAI_KEY', secretRef: 'openai-key' }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: azureOpenAIDeployment }
            { name: 'AZURE_OPENAI_API_VERSION', value: azureOpenAIApiVersion }
            { name: 'AZURE_SPEECH_KEY', secretRef: 'speech-key' }
            { name: 'AZURE_SPEECH_REGION', value: azureSpeechRegion }
          ]
          volumeMounts: [
            {
              volumeName: 'data'
              mountPath: '/app/data'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: envStorage.name
        }
      ]
    }
    configuration: {
      secrets: [
        { name: 'openai-key', value: azureOpenAIKey }
        { name: 'speech-key', value: azureSpeechKey }
        { name: 'registry-password', value: registryPassword }
      ]
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ]
      ingress: {
        external: true
        targetPort: 8787
      }
    }
  }
}

output backendUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
