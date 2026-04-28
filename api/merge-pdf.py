import json, base64
from pypdf import PdfWriter, PdfReader
import io

def handler(request):
    h = {'Access-Control-Allow-Origin':'*','Content-Type':'application/pdf'}
    if request.method == 'OPTIONS':
        return {'statusCode':200,'headers':{**h,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'},'body':''}
    try:
        data = json.loads(request.body)
        pdfs = data.get('pdfs', [])
        filename = data.get('filename', 'merged.pdf')
        
        writer = PdfWriter()
        for b64 in pdfs:
            try:
                pdf_bytes = base64.b64decode(b64)
                reader = PdfReader(io.BytesIO(pdf_bytes))
                for page in reader.pages:
                    writer.add_page(page)
            except Exception as e:
                continue
        
        out = io.BytesIO()
        writer.write(out)
        out.seek(0)
        
        return {
            'statusCode': 200,
            'headers': {**h, 'Content-Disposition': f'attachment; filename="{filename}"'},
            'body': base64.b64encode(out.read()).decode(),
            'isBase64Encoded': True
        }
    except Exception as e:
        return {'statusCode':500,'headers':{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},'body':json.dumps({'error':str(e)})}
