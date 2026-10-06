import type { DriveConfig, DriveProvider } from "@/types/bridge"

/** Everything the setup needs to walk someone through a storage provider: what to click, where, and what to paste. */

export type SetupField = "accountID" | "region" | "endpoint" | "keyID" | "applicationKey" | "bucketName"

export interface GuideStep {
  title: string
  detail: string
  button?: string
  url?: string
}

export const PROVIDERS: { id: DriveProvider; title: string; price: string; blurb: string }[] = [
  { id: "r2", title: "Cloudflare R2", price: "~$15 / TB", blurb: "Free downloads, any amount. About $15/TB a month, 10 GB free." },
  { id: "b2", title: "Backblaze B2", price: "~$7 / TB", blurb: "Cheapest option. About $7/TB a month, with generous free downloads." },
  { id: "s3", title: "Amazon S3", price: "~$23 / TB + downloads", blurb: "The original. About $23/TB a month, plus charges for downloads." },
  { id: "wasabi", title: "Wasabi", price: "~$8 / TB", blurb: "Flat pricing, about $8/TB a month. Deleted files bill for 90 days." },
  { id: "custom", title: "Other S3-compatible", price: "varies", blurb: "Hetzner, MinIO, DigitalOcean Spaces, or anything that speaks the S3 API." },
]

const AWS_REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1", "ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-southeast-1", "ap-southeast-2", "sa-east-1"]
const WASABI_REGIONS = ["us-east-1", "us-east-2", "us-central-1", "us-west-1", "ca-central-1", "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2"]

export function regionsFor(provider: DriveProvider) {
  return provider === "s3" ? AWS_REGIONS : provider === "wasabi" ? WASABI_REGIONS : []
}

export function fieldsFor(provider: DriveProvider): SetupField[] {
  switch (provider) {
    case "b2":
      return ["keyID", "applicationKey", "bucketName"]
    case "r2":
      return ["accountID", "keyID", "applicationKey", "bucketName"]
    case "s3":
    case "wasabi":
      return ["region", "keyID", "applicationKey", "bucketName"]
    case "custom":
      return ["endpoint", "region", "keyID", "applicationKey", "bucketName"]
  }
}

export function labelFor(field: SetupField, provider: DriveProvider) {
  switch (field) {
    case "accountID":
      return "Account ID"
    case "region":
      return provider === "custom" ? "Region (optional)" : "Region"
    case "endpoint":
      return "Endpoint URL"
    case "keyID":
      return provider === "b2" ? "Key ID" : "Access Key ID"
    case "applicationKey":
      return provider === "b2" ? "Application Key" : "Secret Access Key"
    case "bucketName":
      return "Bucket name"
  }
}

export function placeholderFor(field: SetupField, provider: DriveProvider) {
  switch (field) {
    case "accountID":
      return "32-character ID from the R2 overview page"
    case "region":
      return provider === "custom" ? "us-east-1" : ""
    case "endpoint":
      return "https://s3.example.com"
    case "keyID":
      return provider === "b2" ? "e.g. 005a1b2c3d4e5f60000000001" : "Access Key ID"
    case "applicationKey":
      return "Shown only once, when the key is created"
    case "bucketName":
      return "my-ember-drive"
  }
}

/** Why these settings can't be tested yet, or null. */
export function problemWith(config: DriveConfig, hasSavedSecret: boolean): string | null {
  const blank = (text: string) => !text.trim()
  if (blank(config.keyID)) return config.provider === "b2" ? "Enter your Key ID." : "Enter your Access Key ID."
  if (blank(config.applicationKey) && !hasSavedSecret) return config.provider === "b2" ? "Enter your Application Key." : "Enter your Secret Access Key."
  if (blank(config.bucketName)) return "Enter the bucket name."
  if (config.provider === "r2" && blank(config.accountID)) return "Enter your Cloudflare Account ID."
  if ((config.provider === "s3" || config.provider === "wasabi") && blank(config.region)) return "Choose a region."
  if (config.provider === "custom") {
    if (blank(config.endpoint)) return "Enter the endpoint URL."
    try {
      new URL(config.endpoint.includes("://") ? config.endpoint : `https://${config.endpoint}`)
    } catch {
      return "The endpoint should look like https://s3.example.com"
    }
  }
  return null
}

/** A Backblaze master key (12 characters) works but can reach every bucket; a key for one bucket is safer. */
export function looksLikeMasterKey(config: DriveConfig) {
  return config.provider === "b2" && config.keyID.trim().length === 12
}

export function stepsFor(provider: DriveProvider): GuideStep[] {
  switch (provider) {
    case "b2":
      return [
        { title: "Create a Backblaze account", detail: "Skip this if you already have one. B2 includes 10 GB free.", button: "Open Backblaze sign-up", url: "https://www.backblaze.com/sign-up/cloud-storage" },
        { title: "Create a private bucket", detail: "Click “Create a Bucket”, name it (for example my-ember-drive) and keep Files in Bucket set to Private.", button: "Open Buckets", url: "https://secure.backblaze.com/b2_buckets.htm" },
        {
          title: "Create an application key",
          detail: "Click “Add a New Application Key”. Choose Allow access to your bucket only and Read and Write. Copy the keyID and applicationKey straight away; the key is shown only once.",
          button: "Open App Keys",
          url: "https://secure.backblaze.com/app_keys.htm",
        },
        { title: "Paste them below", detail: "Use a key limited to one bucket, not your master key. It's safer if the key is ever exposed." },
      ]
    case "r2":
      return [
        { title: "Sign in to Cloudflare and open R2", detail: "R2 has a free tier (10 GB) and no download fees. It may ask you to add a payment method to turn R2 on.", button: "Open Cloudflare R2", url: "https://dash.cloudflare.com/?to=/:account/r2/overview" },
        { title: "Create a bucket", detail: "Click “Create bucket” and name it (for example my-ember-drive). Leave public access off.", button: "Create a bucket", url: "https://dash.cloudflare.com/?to=/:account/r2/new" },
        {
          title: "Create an API token",
          detail: "Choose “Manage API Tokens”, then Create API token with Object Read & Write, limited to your bucket. Copy the Access Key ID and Secret Access Key, shown only once.",
          button: "Open API tokens",
          url: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens",
        },
        { title: "Find your Account ID", detail: "It's on the R2 overview page, in the right-hand panel (“Account ID”). Paste it below with the keys and bucket name." },
      ]
    case "s3":
      return [
        { title: "Create a bucket", detail: "Pick the region closest to you, keep “Block all public access” ticked, and name the bucket.", button: "Open S3, Create bucket", url: "https://s3.console.aws.amazon.com/s3/bucket/create" },
        {
          title: "Create an IAM user with an access key",
          detail: "In IAM, create a user, attach a policy allowing s3:ListBucket, GetObject, PutObject and DeleteObject on your bucket (and s3:PutLifecycleConfiguration for automatic trash), then create an access key for “Application running outside AWS”.",
          button: "Open IAM users",
          url: "https://console.aws.amazon.com/iam/home#/users",
        },
        { title: "Paste the keys and region below", detail: "S3 charges for downloads (about $0.09/GB after the first 100 GB a month), so heavy streaming costs more here than on B2 or R2." },
      ]
    case "wasabi":
      return [
        { title: "Create a Wasabi account", detail: "There's a free trial. Note that Wasabi bills deleted files for 90 days.", button: "Open Wasabi sign-up", url: "https://wasabi.com/signup/" },
        { title: "Create a bucket", detail: "Choose a region and a name. Keep it private.", button: "Open Buckets", url: "https://console.wasabisys.com/file_manager" },
        { title: "Create an access key", detail: "Under Access Keys choose “Create New Access Key”. Copy both values; the secret is shown only once.", button: "Open Access Keys", url: "https://console.wasabisys.com/access_keys" },
        { title: "Paste them below", detail: "Pick the same region you created the bucket in." },
      ]
    case "custom":
      return [
        {
          title: "Get your endpoint and keys",
          detail: "Any service with an S3-compatible API works: Hetzner Object Storage, DigitalOcean Spaces, MinIO, Linode, Scaleway and more. You need the endpoint URL, an access key, a secret key and a bucket name from your provider's dashboard.",
        },
        { title: "Paste them below", detail: "Use the endpoint exactly as the provider lists it (for example https://fsn1.your-objectstorage.com). Set the region if your provider needs one." },
      ]
  }
}

export const CACHE_SIZES = [5, 10, 20, 50, 100, 250]

export function bytesLabel(bytes: number) {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} bytes`
}
