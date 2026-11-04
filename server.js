import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

// Environment variable checks
const AWS_REGION = process.env.AWS_REGION;
const TABLE_NAME = process.env.TABLE_NAME;
const BUCKET_NAME = process.env.BUCKET_NAME;

if (!AWS_REGION) {
    console.error('Error: AWS_REGION environment variable is not set.');
    process.exit(1);
}
if (!TABLE_NAME) {
    console.error('Error: TABLE_NAME environment variable is not set.');
    process.exit(1);
}
if (!BUCKET_NAME) {
    console.error('Error: BUCKET_NAME environment variable is not set.');
    process.exit(1);
}

// AWS Clients
const ddbClient = new DynamoDBClient({ region: AWS_REGION });
const db = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: AWS_REGION });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('ok');
});

// Helper for key validation
function isValidS3Key(key) {
    return typeof key === 'string' && key.match(/^uploads[/][A-Za-z0-9._-]+$/);
}

// Upload image to S3 and store metadata in DynamoDB
app.post('/upload', express.raw({ type: function () { return true; }, limit: '10mb' }), async (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Request body must be a non-empty buffer.' });
        }

        const originalFileName = String(req.query.name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
        const fileId = randomUUID();
        const s3Key = 'uploads/' + fileId + '-' + originalFileName;
        const contentType = req.headers['content-type'] || 'application/octet-stream';
        const fileSize = req.body.length;
        const createdAt = new Date().toISOString();

        // Upload to S3
        const putObjectCommand = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Body: req.body,
            ContentType: contentType
        });
        await s3.send(putObjectCommand);

        // Store metadata in DynamoDB
        const putItemCommand = new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: 'FILES',
                sk: 'FILE#' + s3Key,
                id: fileId,
                name: originalFileName,
                key: s3Key,
                size: fileSize,
                contentType: contentType,
                createdAt: createdAt
            }
        });
        await db.send(putItemCommand);

        res.status(201).json({ message: 'File uploaded successfully', key: s3Key });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload file', details: error.message });
    }
});

// List images from DynamoDB
app.get('/images', async (req, res) => {
    try {
        const queryCommand = new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: {
                ':pk': 'FILES'
            }
        });
        const { Items } = await db.send(queryCommand);
        res.status(200).json(Items || []);
    } catch (error) {
        console.error('List images error:', error);
        res.status(500).json({ error: 'Failed to list images', details: error.message });
    }
});

// Download image from S3
app.get('/download', async (req, res) => {
    try {
        const key = req.query.key;

        if (!isValidS3Key(key)) {
            return res.status(400).json({ error: 'Invalid S3 key format.' });
        }

        const getObjectCommand = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });

        const response = await s3.send(getObjectCommand);

        if (!response.Body) {
            return res.status(404).json({ error: 'File not found.' });
        }

        const contentType = response.ContentType || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');

        const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        if (imageTypes.includes(contentType)) {
            res.setHeader('Content-Disposition', 'inline');
        } else {
            res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(key) + '"');
        }

        response.Body.pipe(res);

    } catch (error) {
        if (error.name === 'NoSuchKey') {
            return res.status(404).json({ error: 'File not found.' });
        }
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to download file', details: error.message });
    }
});

// Delete image from S3 and metadata from DynamoDB
app.delete('/images', async (req, res) => {
    try {
        const key = req.query.key;

        if (!isValidS3Key(key)) {
            return res.status(400).json({ error: 'Invalid S3 key format.' });
        }

        // Delete from S3
        const deleteObjectCommand = new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        await s3.send(deleteObjectCommand);

        // Delete metadata from DynamoDB
        const deleteItemCommand = new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: 'FILES',
                sk: 'FILE#' + key
            }
        });
        await db.send(deleteItemCommand);

        res.status(200).json({ message: 'File deleted successfully', key: key });

    } catch (error) {
        if (error.name === 'NoSuchKey') {
            // If S3 object doesn't exist, still try to delete DynamoDB entry
            console.warn('S3 object not found for key ' + key + ', proceeding with DynamoDB deletion.');
            try {
                const deleteItemCommand = new DeleteCommand({
                    TableName: TABLE_NAME,
                    Key: {
                        pk: 'FILES',
                        sk: 'FILE#' + key
                    }
                });
                await db.send(deleteItemCommand);
                return res.status(200).json({ message: 'File metadata deleted successfully (S3 object not found)', key: key });
            } catch (dbError) {
                console.error('DynamoDB deletion error after S3 NoSuchKey:', dbError);
                return res.status(500).json({ error: 'Failed to delete file metadata after S3 object not found', details: dbError.message });
            }
        }
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete file', details: error.message });
    }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on http://0.0.0.0:' + PORT);
});
