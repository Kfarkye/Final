import jsPDF from 'jspdf';

export const generateMarkdown = (turns: any[], topic: string, currentUser: any) => {
  let md = `# Conversation Export\n`;
  md += `**Topic**: ${topic}\n`;
  md += `**Date**: ${new Date().toLocaleString()}\n`;
  md += `**User**: ${currentUser?.email}\n\n`;
  md += `---\n\n`;
  turns.forEach((t: any) => {
     md += `**You**: ${t.prompt}\n\n`;
     ['gemini', 'chatgpt', 'claude', 'grok'].forEach(m => {
        if (t.targeted.includes(m) && t.responses?.[m]) {
           md += `**${m.toUpperCase()}**: ${t.responses[m]}\n\n`;
        }
     });
  });
  return md;
};

export const generatePDFDoc = (turns: any[], topic: string, currentUser: any) => {
  const doc = new jsPDF();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  let y = margin;
  
  doc.setFontSize(18);
  doc.text('Conversation Export', margin, y);
  y += 10;
  
  doc.setFontSize(12);
  doc.setTextColor(100);
  doc.text(`Topic: ${topic}`, margin, y);
  y += 6;
  doc.text(`Date: ${new Date().toLocaleString()}`, margin, y);
  y += 6;
  doc.text(`User: ${currentUser?.email}`, margin, y);
  y += 10;
  
  doc.setLineWidth(0.5);
  doc.line(margin, y, doc.internal.pageSize.getWidth() - margin, y);
  y += 10;
  
  doc.setTextColor(0);
  
  turns.forEach((t: any) => {
    doc.setFont("helvetica", "bold");
    doc.text("You:", margin, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    
    // Add text split to lines
    const lines = doc.splitTextToSize(t.prompt, doc.internal.pageSize.getWidth() - margin * 2);
    lines.forEach((line: string) => {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += 6;
    });
    
    y += 4;
    
    ['gemini', 'chatgpt', 'claude', 'grok'].forEach(m => {
       if (t.targeted.includes(m) && t.responses?.[m]) {
          doc.setFont("helvetica", "bold");
          doc.text(`${m.toUpperCase()}:`, margin, y);
          y += 6;
          doc.setFont("helvetica", "normal");
          
          let responseText = String(t.responses[m]);
          // replace some markdown chars for plain text
          responseText = responseText.replace(/\*\*/g, '').replace(/#/g, '');
          
          const respLines = doc.splitTextToSize(responseText, doc.internal.pageSize.getWidth() - margin * 2);
          respLines.forEach((line: string) => {
            if (y > pageHeight - margin) {
              doc.addPage();
              y = margin;
            }
            doc.text(line, margin, y);
            y += 6;
          });
          y += 4;
       }
    });
    y += 8;
  });
  
  return doc;
};

export const saveToDrive = async (token: string, fileContent: string, fileName: string, mimeType: string, isBase64: boolean = false) => {
  const metadata = {
    name: fileName,
    mimeType: mimeType
  };

  const boundary = '-------314159265358979323846';
  const delimiter = "\r\n--" + boundary + "\r\n";
  const close_delim = "\r\n--" + boundary + "--";

  let body = delimiter + 
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: ' + mimeType + '\r\n';

  if (isBase64) {
    body += 'Content-Transfer-Encoding: base64\r\n\r\n' + fileContent + close_delim;
  } else {
    body += '\r\n' + fileContent + close_delim;
  }

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: body
  });

  if (!res.ok) {
    const errObj = await res.json();
    throw new Error('Failed to upload to Drive: ' + errObj.error?.message);
  }
  return await res.json();
};

export const sendEmailAttachment = async (token: string, toEmail: string, subject: string, bodyText: string, attachmentData: string, attachmentName: string, mimeType: string, isBase64: boolean = false) => {
  const boundary = 'foo_bar_baz_' + Date.now();
  
  const contentToEncode = isBase64 ? attachmentData : btoa(unescape(encodeURIComponent(attachmentData)));

  const rawEmail = [
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
    '',
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${attachmentName}"`,
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    'Content-Transfer-Encoding: base64',
    '',
    contentToEncode,
    '',
    `--${boundary}--`
  ].join('\r\n');

  const encodedMsg = btoa(unescape(encodeURIComponent(rawEmail))).replace(/\+/g, '-').replace(/\//g, '_');
  
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encodedMsg })
  });

  if (!res.ok) {
     const errObj = await res.json();
     throw new Error('Failed to send email: ' + errObj.error?.message);
  }
  return await res.json();
};

export const getChatSpaces = async (token: string) => {
  const res = await fetch('https://chat.googleapis.com/v1/spaces', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
     const errObj = await res.json();
     throw new Error('Failed to fetch Chat spaces: ' + errObj.error?.message);
  }
  const data = await res.json();
  return data.spaces || [];
};

export const sendChatMessage = async (token: string, spaceName: string, text: string) => {
  const res = await fetch(`https://chat.googleapis.com/v1/${spaceName}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
     const errObj = await res.json();
     throw new Error('Failed to send chat message: ' + errObj.error?.message);
  }
  return await res.json();
};
